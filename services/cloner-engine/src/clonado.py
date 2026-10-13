"""Comando `clone`: replica campana + adsets + ads en la cuenta destino, todo en PAUSED."""

import copy
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

from . import idiomas
from .campos import AD_FIELDS, ADSET_FIELDS, CAMPAIGN_FIELDS, TARGETING_ACCOUNT_BOUND
from .fbapi import ApiError, Graph, norm_account

# Campos del adset que Meta devuelve pero rechaza al crear uno nuevo.
ADSET_NO_ENVIAR = {
    "id", "campaign_id", "account_id", "effective_status", "status",
    "created_time", "updated_time", "budget_remaining", "recommendations",
    "source_adset_id", "is_dynamic_creative",
}

# Hueco que se sustituye por el nombre de la pagina de cada cuenta destino. No se
# puede resolver en el navegador: hay una pagina por destino y un solo campo de
# nombre, asi que viaja como marcador y lo rellena cada Clonador con la suya.
MARCADOR_PAGINA = "{PAGINA}"


def slug_pagina(nombre: str) -> str:
    """Nombre de pagina como token de naming: sin acentos, espacios ni simbolos.

    'Heru Santoso' -> 'HERUSANTOSO'. El separador del naming es '_', asi que el
    token no puede traer ninguno propio ni romperse en varios.
    """
    base = unicodedata.normalize("NFKD", nombre or "")
    base = "".join(c for c in base if not unicodedata.combining(c))
    return "".join(c for c in base if c.isalnum()).upper()

# Videos ya descargados y limpiados en esta corrida: video_id origen -> ruta local.
# Vive en el modulo, no en el Clonador, porque hay un Clonador por cuenta destino
# y el archivo se prepara una sola vez para todas. Lo que NO se comparte es el
# video *subido* (cache_vid es por instancia): asi cada cuenta acaba con su
# propio asset y un rechazo en una no arrastra a las demas.
_ARCHIVOS_LIMPIOS: Dict[str, str] = {}
_DIR_TEMP: Optional[str] = None

# Metadatos que se quitan al copiar un video: los globales, los de cada stream y
# los capitulos. `-c copy` no recodifica (segundos en vez de minutos, sin perdida
# de calidad) y los flags bitexact evitan que ffmpeg firme el contenedor con su
# propia version.
FFMPEG_LIMPIEZA = [
    "-map_metadata", "-1", "-map_metadata:s:v", "-1", "-map_metadata:s:a", "-1",
    "-map_chapters", "-1", "-c", "copy",
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
]

# Contenedores donde `+faststart` (indice al principio, como Meta espera un video
# para web) tiene sentido. En mkv o webm ffmpeg lo rechaza.
CONTENEDORES_FASTSTART = (".mp4", ".mov", ".m4v")

# Extensiones que se aceptan al limpiar un archivo subido a mano. Cualquier otra
# cosa se trata como mp4: la extension solo elige contenedor de salida.
EXTENSIONES_VIDEO = (".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm")


def limpiar_archivo(entrada: str, salida: str) -> None:
    """Copia el video quitandole los metadatos. Lanza ApiError si ffmpeg falla."""
    args = list(FFMPEG_LIMPIEZA)
    if os.path.splitext(salida)[1].lower() in CONTENEDORES_FASTSTART:
        args += ["-movflags", "+faststart"]
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", entrada] + args + [salida],
        capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(salida):
        raise ApiError(
            {"message": "ffmpeg no pudo limpiar el video: {}".format(
                (proc.stderr or "").strip()[:200] or "sin detalle")}, "ffmpeg")


def limpiar_bytes(datos: bytes, nombre: str) -> Tuple[bytes, bool]:
    """Quita los metadatos de un video que llega en memoria (subida manual).

    Devuelve (datos, limpiado). Si ffmpeg no puede con el formato se devuelve el
    original sin tocar: perder los metadatos no justifica bloquear una subida que
    el usuario esta esperando. Quien llama lo dice en la respuesta.
    """
    ext = os.path.splitext(nombre or "")[1].lower()
    if ext not in EXTENSIONES_VIDEO:
        ext = ".mp4"
    carpeta = tempfile.mkdtemp(prefix="subida_video_")
    try:
        entrada = os.path.join(carpeta, "entrada" + ext)
        salida = os.path.join(carpeta, "salida" + ext)
        with open(entrada, "wb") as fh:
            fh.write(datos)
        try:
            limpiar_archivo(entrada, salida)
        except ApiError:
            return datos, False
        with open(salida, "rb") as fh:
            return fh.read(), True
    except OSError:
        return datos, False
    finally:
        shutil.rmtree(carpeta, ignore_errors=True)


def _dir_temp() -> str:
    global _DIR_TEMP
    if _DIR_TEMP is None or not os.path.isdir(_DIR_TEMP):
        _DIR_TEMP = tempfile.mkdtemp(prefix="clonado_videos_")
    return _DIR_TEMP


def limpiar_cache_videos() -> None:
    """Borra los videos descargados. Se llama al terminar toda la corrida."""
    global _DIR_TEMP
    _ARCHIVOS_LIMPIOS.clear()
    if _DIR_TEMP and os.path.isdir(_DIR_TEMP):
        shutil.rmtree(_DIR_TEMP, ignore_errors=True)
    _DIR_TEMP = None


def esperar_video_listo(g: Graph, video_id: str, intentos: int = 30) -> str:
    """Meta no deja usar un video en un anuncio hasta que termina de procesarlo."""
    estado = "procesando"
    for _ in range(intentos):
        try:
            info = g.get(str(video_id), fields="status")
            estado = (info.get("status") or {}).get("video_status", "?")
            if estado in ("ready", "error"):
                break
        except ApiError:
            pass
        time.sleep(2)
    return estado


def _descargar(url: str, destino: str) -> None:
    """Baja el video a disco por trozos: pueden ser cientos de MB."""
    with requests.get(url, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with open(destino, "wb") as fh:
            for trozo in resp.iter_content(chunk_size=1 << 20):
                if trozo:
                    fh.write(trozo)


def preparar_video_limpio(src: Graph, video_id: str, log=None, como_pagina=None) -> str:
    """Descarga el video de origen y devuelve la ruta de una copia sin metadatos.

    Se hace una sola vez por video y corrida aunque se clone a varias cuentas:
    lo que tiene que ser distinto en cada cuenta es el asset subido, no este
    archivo intermedio.
    """
    ruta = _ARCHIVOS_LIMPIOS.get(video_id)
    if ruta and os.path.exists(ruta):
        return ruta

    info = src.get(str(video_id), fields="source,from")
    fuente = info.get("source")
    if not fuente and como_pagina:
        # Los videos crosspost pertenecen a la pagina que los publico, no a la
        # cuenta publicitaria. Meta omite 'source' —sin dar error, simplemente no
        # manda el campo— a todo token que no sea el de esa pagina.
        page_id = (info.get("from") or {}).get("id")
        cliente = como_pagina(page_id) if page_id else None
        if cliente:
            try:
                fuente = (cliente.get(str(video_id), fields="source") or {}).get("source")
            except ApiError:
                fuente = None
            if fuente and log:
                log("      video {}: 'source' obtenido como la pagina {}".format(
                    video_id, page_id))

    if not fuente:
        propietaria = (info.get("from") or {}).get("name") or "?"
        raise ApiError(
            {"message": "el video no expone 'source' ni con el token de su pagina ({}), asi "
                        "que no se puede descargar para resubirlo; sustituyelo a mano subiendo "
                        "el archivo desde el editor por idioma".format(propietaria)}, video_id)

    carpeta = _dir_temp()
    crudo = os.path.join(carpeta, "{}_crudo.mp4".format(video_id))
    limpio = os.path.join(carpeta, "{}.mp4".format(video_id))
    _descargar(fuente, crudo)
    try:
        limpiar_archivo(crudo, limpio)
    finally:
        os.remove(crudo)

    _ARCHIVOS_LIMPIOS[video_id] = limpio
    if log:
        log("      video {} descargado y limpiado ({:.1f} MB)".format(
            video_id, os.path.getsize(limpio) / 1048576.0))
    return limpio


class Clonador:
    def __init__(self, cfg: Dict[str, str], src: Graph, dst: Graph, dry_run: bool = False,
                 sufijo: str = "", limite_adsets: Optional[int] = None,
                 ediciones: Optional[Dict[str, List[Dict[str, Any]]]] = None,
                 copias: int = 1, copias_por_adset: Optional[Dict[str, int]] = None,
                 nombres_por_adset: Optional[Dict[str, str]] = None,
                 adsets_extra: Optional[List[Dict[str, Any]]] = None,
                 presupuestos_por_adset: Optional[Dict[str, Any]] = None,
                 presupuesto_campana: Optional[Any] = None,
                 un_ad_por_adset: bool = False, forzar_abo: bool = False,
                 presupuesto_abo: Optional[Any] = None,
                 nombre_campana: str = "", nombre_adset: str = "",
                 progreso=None, estructura: Optional[Dict[str, Any]] = None,
                 videos_manuales: Optional[Dict[str, str]] = None):
        self.cfg = cfg
        self.src = src
        self.dst = dst
        self.dry = dry_run
        self.sufijo = sufijo
        self.limite_adsets = limite_adsets
        # {ad_id: [{indice, tipo, valor}, ...]} — ediciones de idioma por anuncio
        self.ediciones = ediciones or {}
        self.copias = max(1, int(copias or 1))
        # {adset_id: n} — cuantas copias de cada adset. Lo que no aparezca usa self.copias.
        self.copias_por_adset = {k: max(0, int(v)) for k, v in (copias_por_adset or {}).items()}
        # {adset_id: nombre} — renombrado individual antes de crear
        self.nombres_por_adset = {k: v for k, v in (nombres_por_adset or {}).items() if v}
        # Adsets añadidos a mano, cada uno copiado de uno existente:
        #   [{base: adset_id, nombre: "...", videos: {video_viejo: video_nuevo}}]
        self.adsets_extra = adsets_extra or []
        # Presupuestos indicados desde la UI, en centavos y como string, que es
        # como los maneja Meta. {adset_id: "5000"} y el de la campana (CBO).
        self.presupuestos_por_adset = {
            k: str(v) for k, v in (presupuestos_por_adset or {}).items() if str(v or "").strip()}
        self.presupuesto_campana = (str(presupuesto_campana).strip()
                                    if str(presupuesto_campana or "").strip() else "")
        # Un adset por cada anuncio, en vez de un adset con todos dentro.
        self.un_ad_por_adset = bool(un_ad_por_adset)
        # Convertir una campana CBO en ABO: el presupuesto baja a los adsets.
        self.forzar_abo = bool(forzar_abo)
        # Presupuesto que se da a cada adset al convertir de CBO a ABO: los adsets
        # de una campana CBO no traen ninguno, y sin el Meta rechaza el adset.
        self.presupuesto_abo = (str(presupuesto_abo).strip()
                                if str(presupuesto_abo or "").strip() else "")
        self._bid_campana = ""    # estrategia de puja heredada al convertir a ABO
        self.nombre_campana = nombre_campana
        self.nombre_adset = nombre_adset
        self.progreso = progreso          # callback(texto) para la UI web
        # Estructura ya leida (plantilla). Si viene, no se consulta la campana origen.
        self.estructura = estructura
        # {video_id_original: video_id_en_destino} — huecos de video ya rellenados
        self.videos_manuales = videos_manuales or {}
        self.dst_account = norm_account(cfg["DST_ACCOUNT_ID"])
        self.src_account = ""
        self.dst_page = cfg.get("DST_PAGE_ID") or ""
        # Nombre de la pagina elegida, para el marcador {PAGINA} del nombre de la
        # campana. Lo manda la UI (ya lo tiene en el selector) y asi no hace falta
        # preguntarselo al API; si no viene, se resuelve al vuelo.
        self.dst_page_nombre = cfg.get("DST_PAGE_NOMBRE") or ""
        self._page_origen = ""    # pagina del origen, para cuando no se cambia
        self._tz_destino: Optional[ZoneInfo] = None   # zona horaria de la cuenta destino
        self._tz_pedida = False
        self.dst_ig = cfg.get("DST_INSTAGRAM_ID") or ""
        self.dst_pixel = cfg.get("DST_PIXEL_ID") or ""
        self.cache_img: Dict[str, str] = {}   # hash origen -> hash destino
        self.cache_vid: Dict[str, str] = {}   # video_id origen -> video_id destino
        self.cache_pbia: Dict[str, Optional[str]] = {}  # page_id -> cuenta IG de respaldo
        self.cache_token_pagina: Dict[str, Optional[Graph]] = {}  # page_id -> cliente de la pagina
        self.fallos: List[str] = []
        self.avisos_media = set()
        self.creados = {"campanas": 0, "adsets": 0, "ads": 0}

    # -- utilidades ------------------------------------------------------

    def log(self, msg: str) -> None:
        print(msg, flush=True)
        if self.progreso:
            self.progreso(msg)

    def _nombre(self, original: str) -> str:
        return "{}{}".format(original or "sin nombre", self.sufijo)

    def _nombre_campana(self, original: str) -> str:
        """El nombre indicado desde la UI gana; si no, se hereda el del origen."""
        return self._nombre(self._resolver_pagina(self.nombre_campana or original))

    def _nombre_para_naming(self) -> str:
        """Nombre de la pagina que se usa en el nombre de la campana."""
        if self.dst_page_nombre:
            return slug_pagina(self.dst_page_nombre)
        # Sin pagina elegida se mantiene la del origen, que hay que preguntar.
        page_id = self.dst_page or self._page_origen
        if not page_id:
            return ""
        cliente = self.dst if self.dst_page else self.src
        try:
            return slug_pagina(cliente.get(page_id, fields="name").get("name") or "")
        except ApiError:
            return ""

    def _resolver_pagina(self, nombre: str) -> str:
        """Sustituye {PAGINA} por la pagina de esta cuenta destino."""
        if MARCADOR_PAGINA not in nombre:
            return nombre
        slug = self._nombre_para_naming()
        if slug:
            return nombre.replace(MARCADOR_PAGINA, slug)
        # Sin pagina resoluble se quita el hueco y el separador que lo acompana,
        # para no dejar un '__' ni un '_' colgando al final.
        self.avisos_media.add(
            "no se pudo resolver el nombre de la pagina para el nombre de la campana")
        limpio = nombre.replace("_" + MARCADOR_PAGINA, "").replace(MARCADOR_PAGINA + "_", "")
        return limpio.replace(MARCADOR_PAGINA, "")

    def _copias_de(self, adset_id: str) -> int:
        """Cuantas veces se crea este adset. 0 = no copiarlo."""
        return self.copias_por_adset.get(adset_id, self.copias)

    def _nombre_adset(self, adset_id: str, original: str, copia: int, total: int,
                      forzado: str = "") -> str:
        """Nombre final del adset. Manda el nombre forzado (adsets anadidos a
        mano), luego el renombrado individual, luego el general, y si no hay
        ninguno se hereda el del origen. Las copias se numeran para distinguirlas."""
        base = self._nombre(
            forzado or self.nombres_por_adset.get(adset_id) or self.nombre_adset or original)
        return "{} #{:02d}".format(base, copia) if total > 1 else base

    @staticmethod
    def _fecha(iso: Optional[str]) -> Optional[datetime]:
        """Fecha ISO de Meta a datetime con zona. None si no se puede leer.

        Meta manda el offset pegado ('-0600') y el fromisoformat de Python 3.9
        solo acepta '-06:00'. Sin meterle los dos puntos, *toda* fecha de Meta se
        leia como invalida y se descartaba, incluidas las que si estaban en el
        futuro.
        """
        if not iso:
            return None
        texto = iso.strip().replace("Z", "+00:00")
        pegado = re.search(r"([+-]\d{2})(\d{2})$", texto)
        if pegado:
            texto = "{}{}:{}".format(texto[:pegado.start()], pegado.group(1), pegado.group(2))
        try:
            return datetime.fromisoformat(texto)
        except ValueError:
            return None

    @staticmethod
    def _futuro(iso: Optional[str]) -> bool:
        """True si la fecha ISO de Meta esta en el futuro."""
        dt = Clonador._fecha(iso)
        return bool(dt and dt > datetime.now(timezone.utc))

    def _zona_destino(self) -> Optional[ZoneInfo]:
        """Zona horaria de la cuenta destino, que es con la que Meta cuenta los dias."""
        if not self._tz_pedida:
            self._tz_pedida = True
            try:
                nombre = self.dst.get(
                    self.dst_account, fields="timezone_name").get("timezone_name")
                if nombre:
                    self._tz_destino = ZoneInfo(nombre)
            except (ApiError, KeyError, ValueError, OSError):
                self._tz_destino = None
        return self._tz_destino

    def _inicio_manana(self) -> str:
        """Medianoche del dia siguiente, en la hora local de la cuenta destino.

        El start_time del origen siempre esta vencido al clonar una campana que ya
        corrio, y Meta entonces arranca el adset en cuanto se activa, a media
        jornada y con el presupuesto del dia ya prorrateado. Empezar a las 00:00
        le da el dia entero. La zona es la de la cuenta destino porque es la que
        Meta usa para cerrar el dia y para los informes.
        """
        zona = self._zona_destino() or timezone.utc
        manana = (datetime.now(zona) + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0)
        return manana.strftime("%Y-%m-%dT%H:%M:%S%z")

    # -- media -----------------------------------------------------------

    def _mapear_imagen(self, hash_origen: str) -> Optional[str]:
        """Descarga la imagen de la cuenta origen y la sube a la destino."""
        if hash_origen in self.cache_img:
            return self.cache_img[hash_origen]
        try:
            resp = self.src.get(
                "{}/adimages".format(self.src_account),
                hashes=json.dumps([hash_origen]), fields="hash,url,name",
            )
            imgs = resp.get("data") or []
            if not imgs:
                raise ApiError({"message": "hash no encontrado en la cuenta origen"}, "adimages")
            url = imgs[0].get("url")
            nombre = imgs[0].get("name") or "{}.jpg".format(hash_origen[:12])

            if self.dry:
                self.cache_img[hash_origen] = "DRY_" + hash_origen[:8]
                return self.cache_img[hash_origen]

            binario = requests.get(url, timeout=120)
            binario.raise_for_status()
            subida = self.dst.post_files(
                "{}/adimages".format(self.dst_account),
                files={"source": (nombre, binario.content)},
            )
            nuevo = list((subida.get("images") or {}).values())[0]["hash"]
            self.cache_img[hash_origen] = nuevo
            self.log("      imagen {}... -> {}...".format(hash_origen[:10], nuevo[:10]))
            return nuevo
        except (ApiError, requests.RequestException, KeyError, IndexError) as e:
            self.fallos.append("imagen {}: {}".format(hash_origen[:12], e))
            return None

    def _mapear_video(self, video_id: str) -> Optional[str]:
        """Sube a la cuenta destino una copia propia del video, sin metadatos.

        Siempre se resube, nunca se reutiliza el video_id del origen: mientras dos
        cuentas cuelgan del mismo objeto, un rechazo en una arrastra a la otra.
        El archivo se sube en multipart (no con file_url) justamente para poder
        pasarlo por ffmpeg antes: con file_url lo descarga Meta y no lo tocamos.
        """
        if video_id in self.cache_vid:
            return self.cache_vid[video_id]
        try:
            if self.dry:
                self.cache_vid[video_id] = "DRY_" + str(video_id)[:8]
                return self.cache_vid[video_id]

            ruta = preparar_video_limpio(
                self.src, video_id, self.log,
                como_pagina=lambda pag: self._como_pagina(pag, self.src))
            with open(ruta, "rb") as fh:
                # Nombre de archivo neutro a proposito: el original es un metadato mas.
                subida = self.dst.post_files(
                    "{}/advideos".format(self.dst_account),
                    files={"source": ("video.mp4", fh)})
            nuevo = subida.get("id")
            if not nuevo:
                raise ApiError({"message": "Meta no devolvio id del video subido"}, video_id)

            estado = esperar_video_listo(self.dst, nuevo)
            if estado == "error":
                raise ApiError({"message": "Meta no pudo procesar el video subido"}, video_id)
            if estado != "ready":
                self.avisos_media.add(
                    "el video {} seguia procesandose al crear el anuncio; si Meta lo rechaza "
                    "por eso, reintenta en unos minutos".format(nuevo))

            self.cache_vid[video_id] = nuevo
            self.log("      video {} -> {} (copia propia, sin metadatos)".format(video_id, nuevo))
            return nuevo
        except (ApiError, requests.RequestException, OSError, KeyError) as e:
            self.fallos.append("video {}: {}".format(video_id, e))
            return None

    # -- targeting y promoted_object -------------------------------------

    # Placements que Meta exige emparejar al crear, aunque devuelva adsets
    # antiguos que solo tienen el primero de la pareja.
    DEPENDENCIAS_PLACEMENT = {
        "instagram_positions": {"explore_home": "explore"},
    }

    def _limpiar_targeting(self, targeting: Dict[str, Any], quitar_audiencias: bool) -> Dict[str, Any]:
        t = copy.deepcopy(targeting or {})
        if quitar_audiencias:
            for clave in TARGETING_ACCOUNT_BOUND:
                t.pop(clave, None)
        # Meta devuelve estas claves pero las rechaza al crear.
        for solo_lectura in ("is_whatsapp_destination_ad", "targeting_automation_applied"):
            t.pop(solo_lectura, None)

        for campo, reglas in self.DEPENDENCIAS_PLACEMENT.items():
            posiciones = t.get(campo)
            if not posiciones:
                continue
            for requiere, necesario in reglas.items():
                if requiere in posiciones and necesario not in posiciones:
                    posiciones.append(necesario)
                    self.log("    + placement '{}' anadido a {} (lo exige '{}')".format(
                        necesario, campo, requiere))
            t[campo] = posiciones
        return t

    def _remapear_promoted(self, po: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not po:
            return None
        nuevo = copy.deepcopy(po)
        if self.dst_pixel and nuevo.get("pixel_id"):
            nuevo["pixel_id"] = self.dst_pixel
        if self.dst_page and nuevo.get("page_id"):
            nuevo["page_id"] = self.dst_page
        return nuevo

    # -- creatives -------------------------------------------------------

    def _como_pagina(self, page_id: str, cliente: Optional[Graph] = None) -> Optional[Graph]:
        """Cliente del API autenticado como la pagina, no como el usuario.

        `cliente` es el token con el que se pide el de la pagina: el de destino
        para la pagina destino (PBIA) y el de origen para las paginas del origen
        (los videos crosspost, que solo su pagina puede descargar).
        """
        base = cliente or self.dst
        clave = "{}:{}".format(page_id, id(base))
        if clave in self.cache_token_pagina:
            return self.cache_token_pagina[clave]
        nuevo = None
        try:
            token = base.get(page_id, fields="access_token").get("access_token")
            if token:
                nuevo = Graph(token, base.base.rsplit("/", 1)[-1])
        except ApiError:
            pass
        self.cache_token_pagina[clave] = nuevo
        return nuevo

    def _pbia_de(self, page_id: str) -> Optional[str]:
        """Cuenta de Instagram respaldada por la pagina (PBIA), creandola si no existe.

        Toda pagina puede tener una cuenta de Instagram "de respaldo" que la
        representa en los anuncios de Instagram sin necesidad de un perfil real.
        Es lo que hay que usar al cambiar de pagina cuando no se indica otra.
        """
        if page_id in self.cache_pbia:
            return self.cache_pbia[page_id]

        # Este endpoint solo acepta un token DE LA PAGINA, no el del usuario o
        # system user: con el token normal responde "(#190) This method must be
        # called with a Page Access Token".
        pagina = self._como_pagina(page_id)
        cuenta = None
        if pagina:
            try:
                existentes = pagina.get_all(
                    "{}/page_backed_instagram_accounts".format(page_id), fields="id,username")
                if existentes:
                    cuenta = existentes[0].get("id")
            except ApiError:
                pass

            if not cuenta:
                try:
                    cuenta = pagina.post(
                        "{}/page_backed_instagram_accounts".format(page_id)).get("id")
                    if cuenta:
                        self.log("      creada cuenta de Instagram de respaldo para la "
                                 "pagina {} -> {}".format(page_id, cuenta))
                except ApiError as e:
                    self.fallos.append(
                        "no se pudo crear la cuenta de Instagram de la pagina {}: {}. "
                        "Elige una cuenta de Instagram a mano.".format(page_id, e.message))
        else:
            self.fallos.append(
                "no se pudo obtener el token de la pagina {}, asi que no hay cuenta de "
                "Instagram que asignar. Elige una a mano en el selector de Instagram."
                .format(page_id))

        self.cache_pbia[page_id] = cuenta
        if cuenta:
            self.avisos_media.add(
                "se cambio de pagina: los anuncios usan la cuenta de Instagram "
                "respaldada por la pagina nueva ({})".format(cuenta))
        return cuenta

    def _remapear_story_spec(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        s = copy.deepcopy(spec)
        if self.dst_page:
            s["page_id"] = self.dst_page
        if self.dst_ig:
            s["instagram_user_id"] = self.dst_ig
            s.pop("instagram_actor_id", None)
        elif self.dst_page:
            # Pagina nueva sin Instagram indicado. La cuenta del origen pertenece
            # a la pagina antigua y Meta la rechaza ("Page doesn't link to any
            # Instagram account"), pero dejarlo vacio tampoco vale cuando el adset
            # tiene placements de Instagram ("Select an Instagram account..."):
            # hay que dar la cuenta respaldada por la pagina nueva.
            s.pop("instagram_user_id", None)
            s.pop("instagram_actor_id", None)
            pbia = self._pbia_de(self.dst_page)
            if pbia:
                s["instagram_user_id"] = pbia

        link = s.get("link_data") or {}
        if link.get("image_hash"):
            nuevo = self._mapear_imagen(link["image_hash"])
            if not nuevo:
                raise ApiError({"message": "no se pudo migrar la imagen del link_data"}, "creative")
            link["image_hash"] = nuevo
        for hijo in link.get("child_attachments") or []:
            if hijo.get("image_hash"):
                nuevo = self._mapear_imagen(hijo["image_hash"])
                if nuevo:
                    hijo["image_hash"] = nuevo

        video = s.get("video_data") or {}
        if video.get("video_id") in self.videos_manuales:
            video["video_id"] = self.videos_manuales[video["video_id"]]
        elif video.get("video_id"):
            nuevo = self._mapear_video(video["video_id"])
            if not nuevo:
                raise ApiError({"message": "no se pudo migrar el video"}, "creative")
            video["video_id"] = nuevo
        if video.get("image_hash"):
            nuevo = self._mapear_imagen(video["image_hash"])
            if nuevo:
                video["image_hash"] = nuevo
        return s

    @staticmethod
    def _quitar_ids_de_labels(nodo: Any, clave_padre: str = "") -> Any:
        """Los adlabels llevan ids de la cuenta origen que no existen en la destino.

        Meta los reasocia por 'name', asi que se quita el 'id' y se conserva el nombre.
        Afecta tanto a 'adlabels' como a los *_label de asset_customization_rules.
        """
        es_label = clave_padre == "adlabels" or clave_padre.endswith("_label")
        if isinstance(nodo, dict):
            limpio = {
                k: Clonador._quitar_ids_de_labels(v, k)
                for k, v in nodo.items()
                if not (es_label and k == "id")
            }
            return limpio
        if isinstance(nodo, list):
            return [Clonador._quitar_ids_de_labels(x, clave_padre) for x in nodo]
        return nodo

    def _remapear_asset_feed(self, afs: Dict[str, Any]) -> Dict[str, Any]:
        a = copy.deepcopy(afs)
        # Campos de solo lectura que Meta devuelve pero rechaza al crear.
        for solo_lectura in ("reasons_to_shop", "shops_bundle", "additional_data"):
            a.pop(solo_lectura, None)

        for img in a.get("images") or []:
            if img.get("hash"):
                nuevo = self._mapear_imagen(img["hash"])
                if nuevo:
                    img["hash"] = nuevo
        for vid in a.get("videos") or []:
            # thumbnail_url es de solo lectura y thumbnail_hash apunta a una imagen
            # de la cuenta origen que el destino no puede usar. Se descartan ambos:
            # Meta regenera la miniatura a partir del propio video.
            vid.pop("thumbnail_url", None)
            if vid.pop("thumbnail_hash", None):
                self.avisos_media.add("miniaturas regeneradas por Meta (no viajan entre cuentas)")
            if vid.get("video_id") in self.videos_manuales:
                # Hueco rellenado a mano: manda siempre sobre cualquier otra via.
                vid["video_id"] = self.videos_manuales[vid["video_id"]]
            elif vid.get("video_id"):
                nuevo = self._mapear_video(vid["video_id"])
                if not nuevo:
                    # Dejar el video_id del origen crearia el anuncio colgando del
                    # asset de la otra cuenta —el contagio que se quiere evitar—, y
                    # ademas en silencio: el ad aparece creado y parece correcto.
                    raise ApiError(
                        {"message": "no se pudo migrar el video {} y no se reutiliza el del "
                                    "origen; el anuncio no se crea".format(vid["video_id"])},
                        "creative")
                vid["video_id"] = nuevo
        return self._quitar_ids_de_labels(a)

    def _payload_creative(self, creative: Dict[str, Any], nombre_ad: str,
                          ad_id: str = "") -> Dict[str, Any]:
        post_id = creative.get("effective_object_story_id") or creative.get("object_story_id")
        spec = creative.get("object_story_spec")
        afs = creative.get("asset_feed_spec")
        payload: Dict[str, Any] = {"name": self._nombre(creative.get("name") or nombre_ad)}

        # Ediciones pedidas desde la UI. Las hay de dos clases: las que afectan a
        # un idioma concreto (textos, urls, video) y las del creative entero
        # (url_tags), que no llevan indice de idioma.
        todas = self.ediciones.get(ad_id) or []
        por_idioma = [e for e in todas if e.get("tipo") in idiomas.TIPOS]
        de_creative = {e["tipo"]: e.get("valor", "") for e in todas
                       if e.get("tipo") not in idiomas.TIPOS}

        if afs and por_idioma:
            afs, notas = idiomas.aplicar(afs, por_idioma)
            for n in notas:
                self.log("      idioma: {}".format(n))
            self.log("      {} edicion(es) de idioma aplicadas".format(len(por_idioma)))

        if afs:
            # Creative dinamico: el post publicado es solo una de las variantes
            # generadas. Reutilizarlo perderia la personalizacion (idioma, formatos),
            # asi que se recrea el feed completo.
            payload["asset_feed_spec"] = self._remapear_asset_feed(afs)
            payload["object_story_spec"] = self._remapear_story_spec(spec or {})
        elif spec:
            # Antes, con la misma pagina, aqui se reutilizaba el post publicado
            # (object_story_id) para conservar el social proof. Se quito: es el
            # vinculo mas fuerte de todos —los dos ads son literalmente el mismo
            # post— y un rechazo en el origen tumbaba tambien a la copia.
            payload["object_story_spec"] = self._remapear_story_spec(spec)
        elif post_id:
            raise ApiError({"message": "el ad solo tiene object_story_id (un post ya publicado, "
                                       "sin spec que recrear) y ya no se reutilizan posts; hay "
                                       "que publicar el post en la pagina de destino"},
                           "creative")
        else:
            raise ApiError({"message": "creative sin spec reutilizable"}, "creative")

        for clave in ("url_tags", "degrees_of_freedom_spec", "contextual_multi_ads",
                      "template_url_spec", "call_to_action_type", "authorization_category"):
            if creative.get(clave):
                payload[clave] = creative[clave]

        dof = self._limpiar_mejoras(payload.get("degrees_of_freedom_spec"), nombre_ad)
        if dof is None:
            payload.pop("degrees_of_freedom_spec", None)
        else:
            payload["degrees_of_freedom_spec"] = dof

        if "url_tags" in de_creative:
            # Cadena vacia = quitar los parametros de URL, asi que no vale un `if valor`.
            payload["url_tags"] = de_creative["url_tags"]
            self.log("      parametros de URL cambiados")
        return payload

    def _crear_creative(self, creative: Dict[str, Any], nombre_ad: str,
                        ad_id: str = "") -> Optional[str]:
        """Recrea el creative en la cuenta destino y devuelve su id.

        El media siempre se resube como copia propia de la cuenta destino. No hay
        via de reutilizacion ni como plan B: si la resubida falla, falla el ad y
        queda en incidencias, porque caer en silencio al asset del origen es justo
        lo que hace que un rechazo se propague de una cuenta a la siguiente.
        """
        payload = self._payload_creative(creative, nombre_ad, ad_id=ad_id)
        if self.dry:
            self.log("      [dry-run] creative: {}".format(self._resumen_creative(payload)))
            return "DRY_CREATIVE"
        res = self.dst.post("{}/adcreatives".format(self.dst_account), **payload)
        return res.get("id")

    def _limpiar_mejoras(self, dof: Optional[Dict[str, Any]],
                         nombre_ad: str) -> Optional[Dict[str, Any]]:
        """Quita el campo de mejoras estandar, que Meta ya no acepta al crear.

        Los anuncios antiguos llevan `creative_features_spec.standard_enhancements`.
        Meta los sigue sirviendo, pero al crear uno nuevo responde "Including
        standard enhancements field in creative has been deprecated. Please choose
        to set individual features instead" y el anuncio no se crea. Los anuncios
        modernos usan features sueltas (ig_video_native_subtitle, product_browsing...),
        que si se copian tal cual.
        """
        if not dof:
            return dof
        limpio = copy.deepcopy(dof)
        features = limpio.get("creative_features_spec") or {}
        if "standard_enhancements" not in features:
            return limpio

        features.pop("standard_enhancements", None)
        self.avisos_media.add(
            "el anuncio '{}' tenia activadas las mejoras estandar (standard_enhancements), "
            "un campo que Meta ya no admite al crear anuncios: se copia sin el. Si las "
            "quieres, activalas en el Ads Manager como funciones sueltas.".format(nombre_ad))

        if features:
            limpio["creative_features_spec"] = features
        else:
            limpio.pop("creative_features_spec", None)
        return limpio or None

    @staticmethod
    def _resumen_adset(payload: Dict[str, Any]) -> str:
        """Resumen legible del adset. El JSON crudo se cortaba justo antes del
        presupuesto, que es lo que mas interesa comprobar antes de lanzar."""
        partes = []
        for clave, etq in (("daily_budget", "presupuesto diario"),
                           ("lifetime_budget", "presupuesto total")):
            if payload.get(clave):
                partes.append("{} {:.2f}".format(etq, int(payload[clave]) / 100))
        if not partes:
            partes.append("presupuesto en la campana (CBO)")
        for clave in ("optimization_goal", "billing_event", "bid_strategy"):
            if payload.get(clave):
                partes.append(str(payload[clave]))
        tgt = payload.get("targeting") or {}
        geo = (tgt.get("geo_locations") or {}).get("countries")
        if geo:
            partes.append("geo {}".format(",".join(geo)))
        if tgt.get("age_min") or tgt.get("age_max"):
            partes.append("edad {}-{}".format(tgt.get("age_min", "?"), tgt.get("age_max", "?")))
        if payload.get("start_time"):
            partes.append("inicio {}".format(payload["start_time"][:16].replace("T", " ")))
        po = payload.get("promoted_object") or {}
        if po.get("pixel_id"):
            partes.append("pixel {}".format(po["pixel_id"]))
        return " | ".join(partes)

    @staticmethod
    def _resumen_creative(payload: Dict[str, Any]) -> str:
        """Resumen legible del creative para la consola (el JSON crudo es ilegible)."""
        partes = []
        # La pagina va primero: al copiar a varios destinos es lo que se compara.
        spec_ini = payload.get("object_story_spec") or {}
        if spec_ini.get("page_id"):
            partes.append("page {}".format(spec_ini["page_id"]))
        if spec_ini.get("instagram_user_id"):
            partes.append("ig {}".format(spec_ini["instagram_user_id"]))
        if payload.get("object_story_id"):
            partes.append("post existente {}".format(payload["object_story_id"]))
        afs = payload.get("asset_feed_spec") or {}
        if afs:
            partes.append("{} idiomas".format(len(afs.get("asset_customization_rules") or [])))
            for tipo, (lista, _, _) in idiomas.TIPOS.items():
                if afs.get(lista):
                    partes.append("{} {}".format(len(afs[lista]), tipo))
            urls = {u.get("website_url") for u in afs.get("link_urls") or []}
            if urls:
                partes.append("{} url(s) distintas: {}".format(
                    len(urls), ", ".join(sorted(urls)[:3])[:120]))
        return " | ".join(partes) or "(sin contenido)"

    # -- niveles ---------------------------------------------------------

    def crear_campana(self, camp: Dict[str, Any]) -> str:
        payload: Dict[str, Any] = {
            "name": self._nombre_campana(camp.get("name")),
            "objective": camp.get("objective"),
            "status": "PAUSED",
            "special_ad_categories": camp.get("special_ad_categories") or [],
        }
        if camp.get("buying_type"):
            payload["buying_type"] = camp["buying_type"]
        if camp.get("special_ad_category_country"):
            payload["special_ad_category_country"] = camp["special_ad_category_country"]
        # Presupuesto a nivel campana (CBO) solo si el original lo tiene y no se
        # ha pedido convertirla a ABO. Al convertir se va tambien la estrategia de
        # puja: sin presupuesto de campana Meta la rechaza ("This campaign doesn't
        # have a budget"), porque en ABO la puja vive en el adset.
        for clave in ("daily_budget", "lifetime_budget", "bid_strategy"):
            if camp.get(clave) and not self.forzar_abo:
                payload[clave] = camp[clave]
        # Se guarda para dársela a los adsets, que en CBO no la traen.
        self._bid_campana = camp.get("bid_strategy") or ""

        # Presupuesto de campana cambiado desde la UI: se respeta si es diario o
        # total, tal como lo tuviera el original.
        if self.presupuesto_campana and (camp.get("daily_budget") or camp.get("lifetime_budget")):
            clave = "daily_budget" if camp.get("daily_budget") else "lifetime_budget"
            payload[clave] = self.presupuesto_campana
            self.log("  presupuesto de campana: {} -> {}".format(
                camp.get(clave), self.presupuesto_campana))

        # Sin CBO (campana ABO), Meta exige decir explicitamente si los adsets
        # comparten presupuesto; omitirlo aborta la creacion. Se replica el valor
        # del origen y, si no viniera, se deja en False, que es no compartir.
        if self.forzar_abo or not (camp.get("daily_budget") or camp.get("lifetime_budget")):
            payload["is_adset_budget_sharing_enabled"] = bool(
                camp.get("is_adset_budget_sharing_enabled"))
            if self.forzar_abo and (camp.get("daily_budget") or camp.get("lifetime_budget")):
                self.log("  CBO -> ABO: el presupuesto pasa de la campana a los adsets")

        self.log("\nCAMPANA: {}".format(payload["name"]))
        if self.dry:
            self.log("  [dry-run] payload: {}".format(json.dumps(payload, ensure_ascii=False)[:400]))
            return "DRY_CAMPAIGN"
        res = self.dst.post("{}/campaigns".format(self.dst_account), **payload)
        self.creados["campanas"] += 1
        self.log("  creada -> {}".format(res.get("id")))
        return res["id"]

    def _payload_adset(self, adset: Dict[str, Any], nueva_campana: str,
                       campana_con_cbo: bool, quitar_audiencias: bool,
                       copia: int = 1, total: int = 1, nombre: str = "",
                       presupuesto: str = "") -> Dict[str, Any]:
        payload = {k: v for k, v in adset.items() if k not in ADSET_NO_ENVIAR and v not in (None, "")}
        payload["name"] = self._nombre_adset(adset.get("id"), adset.get("name"),
                                             copia, total, nombre)
        payload["campaign_id"] = nueva_campana
        payload["status"] = "PAUSED"
        payload["targeting"] = self._limpiar_targeting(adset.get("targeting"), quitar_audiencias)

        promo = self._remapear_promoted(adset.get("promoted_object"))
        if promo:
            payload["promoted_object"] = promo
        else:
            payload.pop("promoted_object", None)

        # Presupuesto cambiado desde la UI para este adset (o para el adset
        # anadido que lo esta usando de base).
        nuevo_pres = (presupuesto or self.presupuestos_por_adset.get(adset.get("id"))
                      or (self.presupuesto_abo if self.forzar_abo else ""))
        if nuevo_pres and not campana_con_cbo:
            clave = "lifetime_budget" if (adset.get("lifetime_budget")
                                          and not adset.get("daily_budget")) else "daily_budget"
            payload.pop("daily_budget", None)
            payload.pop("lifetime_budget", None)
            payload[clave] = str(nuevo_pres)

        # Al convertir a ABO el adset asume la estrategia de puja de la campana,
        # porque los adsets de una campana CBO no traen la suya.
        if self.forzar_abo and not payload.get("bid_strategy") and self._bid_campana:
            payload["bid_strategy"] = self._bid_campana

        # Con CBO el presupuesto vive en la campana, no en el adset.
        if campana_con_cbo:
            payload.pop("daily_budget", None)
            payload.pop("lifetime_budget", None)
            payload.pop("bid_strategy", None)

        # Meta rechaza este valor aunque lo devuelva en las lecturas.
        if payload.get("destination_type") == "UNDEFINED":
            payload.pop("destination_type")

        # Las fechas pasadas no se pueden reutilizar en un objeto nuevo. La del
        # origen casi siempre lo esta (es la de creacion del adset), y dejarla
        # fuera hace que Meta arranque al activar: se programa manana a las 00:00.
        # Una fecha futura del origen si es una programacion deliberada y se respeta.
        if not self._futuro(payload.get("start_time")):
            payload["start_time"] = self._inicio_manana()
        if not self._futuro(payload.get("end_time")):
            payload.pop("end_time", None)
            # Sin end_time un presupuesto total no es valido.
            if payload.get("lifetime_budget") and not payload.get("daily_budget"):
                payload["daily_budget"] = payload.pop("lifetime_budget")
        else:
            # Los offsets pueden no coincidir (cuentas en zonas distintas), asi que
            # se comparan como fechas y no como texto.
            fin = self._fecha(payload.get("end_time"))
            inicio = self._fecha(payload.get("start_time"))
            if fin and inicio and fin <= inicio:
                # El fin quedaba antes del arranque nuevo: Meta lo rechaza.
                self.avisos_media.add(
                    "el adset terminaba antes del nuevo inicio ({}): se copia sin fecha "
                    "de fin".format(payload["start_time"][:10]))
                payload.pop("end_time", None)
                if payload.get("lifetime_budget") and not payload.get("daily_budget"):
                    payload["daily_budget"] = payload.pop("lifetime_budget")

        return payload

    def crear_adset(self, adset: Dict[str, Any], nueva_campana: str,
                    campana_con_cbo: bool, copia: int = 1, total: int = 1,
                    nombre: str = "") -> Optional[str]:
        payload = self._payload_adset(adset, nueva_campana, campana_con_cbo,
                                      quitar_audiencias=False, copia=copia, total=total,
                                      nombre=nombre)
        if self.dry:
            self.log("  [dry-run] adset: {}".format(self._resumen_adset(payload)))
            return "DRY_ADSET"
        try:
            res = self.dst.post("{}/adsets".format(self.dst_account), **payload)
        except ApiError as e:
            # Causa tipica cross-cuenta: audiencias personalizadas que no existen alli.
            if not self._error_de_audiencia(e):
                raise
            self.log("    ! audiencias no disponibles en el destino — reintentando sin ellas")
            payload = self._payload_adset(adset, nueva_campana, campana_con_cbo,
                                          quitar_audiencias=True, copia=copia, total=total,
                                          nombre=nombre, presupuesto=presupuesto)
            res = self.dst.post("{}/adsets".format(self.dst_account), **payload)
            self.fallos.append("adset '{}': se copio sin las audiencias personalizadas".format(
                adset.get("name")))
        self.creados["adsets"] += 1
        return res["id"]

    @staticmethod
    def _error_de_audiencia(e: ApiError) -> bool:
        texto = (e.message or "").lower()
        claves = ("custom audience", "audiencia personalizada", "publico personalizado",
                  "does not exist", "no existe", "permission", "not available")
        return any(c in texto for c in claves)

    def crear_ad(self, ad: Dict[str, Any], nuevo_adset: str) -> Optional[str]:
        creative = ad.get("creative") or {}
        creative_id = self._crear_creative(creative, ad.get("name") or "", ad.get("id") or "")
        if not creative_id:
            return None
        payload = {
            "name": self._nombre(ad.get("name")),
            "adset_id": nuevo_adset,
            "creative": {"creative_id": creative_id},
            "status": "PAUSED",
        }
        if ad.get("conversion_domain"):
            payload["conversion_domain"] = ad["conversion_domain"]
        if self.dry:
            self.log("      [dry-run] ad: {}".format(payload["name"]))
            return "DRY_AD"
        res = self.dst.post("{}/ads".format(self.dst_account), **payload)
        self.creados["ads"] += 1
        return res["id"]

    # -- orquestacion ------------------------------------------------------

    def leer_origen(self) -> Dict[str, Any]:
        """Volcado de la campana origen. Es tambien el formato de las plantillas."""
        campaign_id = self.cfg["SRC_CAMPAIGN_ID"]
        return {
            "campana": self.src.get(campaign_id, fields=CAMPAIGN_FIELDS),
            "adsets": self.src.get_all("{}/adsets".format(campaign_id), fields=ADSET_FIELDS),
            "ads": self.src.get_all("{}/ads".format(campaign_id), fields=AD_FIELDS),
        }

    def ejecutar(self) -> Dict[str, Any]:
        # Desde plantilla: la estructura ya viene dada y no se toca el origen.
        datos = self.estructura or self.leer_origen()
        camp = datos["campana"]
        adsets = list(datos["adsets"])
        ads = list(datos["ads"])

        self.src_account = norm_account(camp.get("account_id", ""))
        # Para {PAGINA} cuando no se cambia de pagina: la del primer ad que la traiga.
        for ad in ads:
            spec = (ad.get("creative") or {}).get("object_story_spec") or {}
            if spec.get("page_id"):
                self._page_origen = str(spec["page_id"])
                break
        # Con forzar_abo el presupuesto deja de estar en la campana, asi que los
        # adsets pasan a llevarlo (el payload del adset mira esta bandera).
        cbo = bool(camp.get("daily_budget") or camp.get("lifetime_budget")) and not self.forzar_abo

        por_adset: Dict[str, List[Dict[str, Any]]] = {}
        for ad in ads:
            por_adset.setdefault(ad.get("adset_id"), []).append(ad)

        if self.limite_adsets:
            adsets = adsets[: self.limite_adsets]
            self.log("(limitado a los primeros {} adsets)".format(self.limite_adsets))

        total_adsets = sum(self._copias_de(a["id"]) for a in adsets)
        total_ads = sum(len(por_adset.get(a["id"], [])) * self._copias_de(a["id"])
                        for a in adsets)
        if self.estructura:
            self.log("Origen : plantilla — {}".format(camp.get("name")))
        else:
            self.log("Origen : {} — {}".format(self.src_account, camp.get("name")))
        self.log("Destino: {}".format(self.dst_account))
        extra_ads = 0
        for e in self.adsets_extra:
            extra_ads += len(por_adset.get(e.get("base"), []))
        self.log("A copiar: {} adsets, {} ads{}{}".format(
            total_adsets + len(self.adsets_extra), total_ads + extra_ads,
            "  ({} adset(s) anadidos a mano)".format(len(self.adsets_extra))
            if self.adsets_extra else "",
            "  [DRY-RUN, no se escribe nada]" if self.dry else ""))
        for a in adsets:
            n = self._copias_de(a["id"])
            renombrado = self.nombres_por_adset.get(a["id"])
            if n != 1 or renombrado:
                self.log("   - {} -> {}{}".format(
                    a.get("name"), renombrado or a.get("name"),
                    " x{}".format(n) if n != 1 else ""))
        if self.ediciones:
            self.log("Ediciones de idioma en {} anuncio(s)".format(len(self.ediciones)))

        if self.forzar_abo and not self.presupuesto_abo and not self.presupuestos_por_adset:
            raise ApiError({"message":
                "para convertir la campana a ABO hace falta indicar el presupuesto de cada "
                "adset: los adsets de una campana CBO no traen ninguno propio"}, "abo")

        nueva_campana = self.crear_campana(camp)

        if self.un_ad_por_adset:
            self._crear_uno_por_ad(adsets, por_adset, nueva_campana, cbo)
            return self._cerrar(nueva_campana, camp)

        total = sum(self._copias_de(a["id"]) for a in adsets)
        hecho = 0
        for adset in adsets:
            veces = self._copias_de(adset["id"])
            if veces < 1:
                self.log("\n  (omitido: {})".format(adset.get("name")))
                continue
            for copia in range(1, veces + 1):
                hecho += 1
                self.log("\n  [{}/{}] ADSET: {}".format(
                    hecho, total,
                    self._nombre_adset(adset["id"], adset.get("name"), copia, veces)))
                try:
                    nuevo_adset = self.crear_adset(adset, nueva_campana, cbo,
                                                   copia=copia, total=veces)
                except ApiError as e:
                    self.log("    FALLO adset: {}".format(e.message))
                    self.fallos.append("adset '{}' (copia {}): {}".format(
                        adset.get("name"), copia, e.message))
                    continue
                self.log("    creado -> {}".format(nuevo_adset))

                for ad in por_adset.get(adset["id"], []):
                    try:
                        nuevo_ad = self.crear_ad(ad, nuevo_adset)
                        self.log("    ad ok -> {} ({})".format(nuevo_ad, (ad.get("name") or "")[:40]))
                    except ApiError as e:
                        self.log("    FALLO ad '{}': {}".format((ad.get("name") or "")[:40], e.message))
                        self.fallos.append("ad '{}' (copia {}): {}".format(
                            ad.get("name"), copia, e.message))

        # Adsets anadidos a mano: cada uno copia a uno existente pero con su
        # propio nombre y sus propios videos.
        for i, extra in enumerate(self.adsets_extra, 1):
            base = next((a for a in datos["adsets"] if a["id"] == extra.get("base")), None)
            if not base:
                self.fallos.append("adset anadido #{}: no se encontro el adset de "
                                   "origen {}".format(i, extra.get("base")))
                continue

            nombre = (extra.get("nombre") or "").strip()
            self.log("\n  [+{}/{}] ADSET NUEVO: {}  (copia de {})".format(
                i, len(self.adsets_extra), nombre or base.get("name"), base.get("name")))

            # Los videos propios de este adset solo valen mientras se crea el.
            videos_antes = self.videos_manuales
            self.videos_manuales = dict(videos_antes)
            self.videos_manuales.update(extra.get("videos") or {})
            try:
                nuevo_adset = self.crear_adset(base, nueva_campana, cbo, nombre=nombre,
                                               presupuesto=str(extra.get("presupuesto") or ""))
                self.log("    creado -> {}".format(nuevo_adset))
                for ad in por_adset.get(base["id"], []):
                    try:
                        nuevo_ad = self.crear_ad(ad, nuevo_adset)
                        self.log("    ad ok -> {} ({})".format(
                            nuevo_ad, (ad.get("name") or "")[:40]))
                    except ApiError as e:
                        self.log("    FALLO ad '{}': {}".format(
                            (ad.get("name") or "")[:40], e.message))
                        self.fallos.append("ad '{}' del adset anadido '{}': {}".format(
                            ad.get("name"), nombre or base.get("name"), e.message))
            except ApiError as e:
                self.log("    FALLO adset: {}".format(e.message))
                self.fallos.append("adset anadido '{}': {}".format(
                    nombre or base.get("name"), e.message))
            finally:
                self.videos_manuales = videos_antes

        return self._cerrar(nueva_campana, camp)

    def _crear_uno_por_ad(self, adsets, por_adset, nueva_campana, cbo) -> None:
        """Un adset por cada anuncio, en vez de un adset con todos dentro.

        Sirve para pasar de CBO (un adset con N anuncios compitiendo por el mismo
        presupuesto) a ABO (N adsets, cada uno con su presupuesto y un anuncio).
        Cada adset hereda targeting, optimizacion y pixel del adset de origen del
        anuncio, y toma su nombre para poder reconocerlo.
        """
        pares = []
        for adset in adsets:
            if self._copias_de(adset["id"]) < 1:
                continue
            for ad in por_adset.get(adset["id"], []):
                pares.append((adset, ad))

        self.log("\nUn anuncio por adset: {} anuncio(s) -> {} adset(s)".format(
            len(pares), len(pares)))

        for i, (adset, ad) in enumerate(pares, 1):
            nombre = self._nombre(self.nombre_adset or ad.get("name") or adset.get("name"))
            self.log("\n  [{}/{}] ADSET: {}".format(i, len(pares), nombre))
            try:
                nuevo_adset = self.crear_adset(adset, nueva_campana, cbo, nombre=nombre)
            except ApiError as e:
                self.log("    FALLO adset: {}".format(e.message))
                self.fallos.append("adset '{}': {}".format(nombre, e.message))
                continue
            self.log("    creado -> {}".format(nuevo_adset))
            try:
                nuevo_ad = self.crear_ad(ad, nuevo_adset)
                self.log("    ad ok -> {} ({})".format(nuevo_ad, (ad.get("name") or "")[:40]))
            except ApiError as e:
                self.log("    FALLO ad '{}': {}".format((ad.get("name") or "")[:40], e.message))
                self.fallos.append("ad '{}': {}".format(ad.get("name"), e.message))

    def _cerrar(self, nueva_campana, camp) -> Dict[str, Any]:
        self.log("\n" + "=" * 72)
        self.log("RESULTADO: {} campana, {} adsets, {} ads creados en {} — todos en PAUSED".format(
            self.creados["campanas"], self.creados["adsets"], self.creados["ads"], self.dst_account))
        for aviso in sorted(self.avisos_media):
            self.log("Nota: {}".format(aviso))
        if self.fallos:
            self.log("\nINCIDENCIAS ({}):".format(len(self.fallos)))
            for i, f in enumerate(self.fallos, 1):
                self.log("  {}. {}".format(i, f))
        self.log("=" * 72)
        return {
            "campana_id": nueva_campana,
            "nombre_campana": self._nombre_campana(camp.get("name")),
            "nombre_origen": camp.get("name"),
            "cuenta_origen": self.src_account,
            "creados": self.creados,
            "fallos": self.fallos,
            "avisos": sorted(self.avisos_media),
        }
