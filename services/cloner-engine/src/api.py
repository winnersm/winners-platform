"""
Motor de clonado, como servicio interno.

Es el `servidor.py` de opwinners sin su interfaz: la web la sirve ahora la app
Next.js, que llama aquí por la red interna de Docker. El motor de clonado
(`clonado.py`) no se ha tocado — es donde vive todo lo aprendido a base de
golpes con la Graph API (crossposts, PBIA, asset_feed_spec, adlabels) y
reescribirlo habría sido regalar fallos.

Diferencias con el original:

  - No escucha en localhost ni abre el navegador: vive en `winners-net` y solo
    la app puede alcanzarlo. No tiene etiquetas de Traefik, así que no sale a
    internet.
  - Toda petición trae `X-Engine-Token`. Sin él se rechaza: la red interna es
    una barrera, no una autorización.
  - Los tokens, plantillas, historial y trabajos van a Postgres (`store.py`),
    no a un SQLite junto al código.
  - Los trabajos sobreviven a un reinicio del contenedor.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import requests

from . import clonado, idiomas, store
from .campos import AD_FIELDS, ADSET_FIELDS, CAMPAIGN_FIELDS
from .fbapi import ApiError, Graph, norm_account

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("cloner")

PUERTO = int(os.environ.get("CLONER_PORT", "8760"))
VERSION_API = os.environ.get("GRAPH_VERSION", "v23.0")
TOKEN_SERVICIO = os.environ.get("CLONER_ENGINE_TOKEN", "")

# Catálogo de locales de Meta (id -> nombre), se carga una vez por proceso.
_LOCALES: Dict[int, str] = {}

# Miniaturas ya descargadas: video_id -> (bytes, content-type)
_MINIATURAS: Dict[str, Tuple[bytes, str]] = {}
_CANDADO_MINIATURAS = threading.Lock()


def graph_de(alias: str) -> Graph:
    token = store.obtener_token(alias)
    if not token:
        raise ValueError("no hay ningún token guardado con el alias '{}'".format(alias))
    return Graph(token, VERSION_API)


def locales(g: Optional[Graph] = None) -> Dict[int, str]:
    """Catálogo de locales de Meta. Se guarda en la base para poder mostrar los
    nombres de idioma también donde no hay token a mano (p. ej. plantillas)."""
    global _LOCALES
    if _LOCALES:
        return _LOCALES
    guardado = store.cache_leer("locales")
    if guardado:
        _LOCALES = {int(k): v for k, v in guardado.items()}
        return _LOCALES
    if g is not None:
        _LOCALES = idiomas.cargar_locales(g)
        if _LOCALES:
            store.cache_guardar("locales", {str(k): v for k, v in _LOCALES.items()})
    return _LOCALES


# --------------------------------------------------------------------------
# Handlers de la API — mismas rutas y mismas respuestas que la app original.
# --------------------------------------------------------------------------

def api_tokens_listar(_q, _b):
    return {"tokens": store.listar_tokens()}


def api_tokens_guardar(_q, body):
    alias = (body.get("alias") or "").strip()
    token = (body.get("token") or "").strip()
    if not alias or not token:
        raise ValueError("hacen falta 'alias' y 'token'")
    store.guardar_token(alias, token, body.get("usuario"))
    # Validación inmediata: así se ve al momento si sirve.
    try:
        yo = Graph(token, VERSION_API).get("me", fields="id,name")
        store.marcar_token(alias, True, yo.get("name", ""), yo.get("id", ""))
        return {"ok": True, "valido": True, "usuario": yo.get("name"),
                "usuario_id": yo.get("id")}
    except ApiError as e:
        store.marcar_token(alias, False, error=e.message)
        return {"ok": True, "valido": False, "error": e.message}


def api_tokens_borrar(q, _b):
    store.borrar_token(q.get("alias", [""])[0])
    return {"ok": True}


def api_cuentas(q, _b):
    g = graph_de(q.get("alias", [""])[0])
    cuentas = g.get_all("me/adaccounts",
                        fields="id,name,account_status,currency,business")
    return {"cuentas": [
        {
            "id": c["id"],
            "nombre": c.get("name", ""),
            "activa": c.get("account_status") == 1,
            "moneda": c.get("currency", ""),
            "business": (c.get("business") or {}).get("name", ""),
        }
        for c in sorted(cuentas, key=lambda x: x.get("name", ""))
    ]}


def api_campanas(q, _b):
    g = graph_de(q.get("alias", [""])[0])
    cuenta = norm_account(q.get("cuenta", [""])[0])
    camps = g.get_all("{}/campaigns".format(cuenta),
                      fields="id,name,status,objective,daily_budget,lifetime_budget,updated_time")
    camps.sort(key=lambda c: c.get("updated_time", ""), reverse=True)
    return {"campanas": [
        {
            "id": c["id"], "nombre": c.get("name", ""), "estado": c.get("status", ""),
            "objetivo": c.get("objective", ""),
            "presupuesto": c.get("daily_budget") or c.get("lifetime_budget") or "",
        }
        for c in camps
    ]}


def api_campana(q, _b):
    """Detalle de una campaña, leído en el acto.

    Se conserva para campañas pequeñas y para llamadas internas. Desde la web se
    usa `api_campana_cargar`, porque una campaña de cien anuncios tarda más de
    los 100 s que Cloudflare da de margen.
    """
    return leer_campana(q.get("alias", [""])[0], q.get("id", [""])[0])


def leer_campana(alias: str, cid: str) -> Dict[str, Any]:
    g = graph_de(alias)
    camp = g.get(cid, fields=CAMPAIGN_FIELDS)
    adsets = g.get_all("{}/adsets".format(cid), fields=ADSET_FIELDS)
    ads = g.get_all("{}/ads".format(cid), fields=AD_FIELDS)

    mapa = locales(g)
    lista_ads = []
    for ad in ads:
        creative = ad.get("creative") or {}
        afs = creative.get("asset_feed_spec")
        lista_ads.append({
            "id": ad["id"],
            "nombre": ad.get("name", ""),
            "estado": ad.get("status", ""),
            "adset_id": ad.get("adset_id"),
            "url_tags": creative.get("url_tags") or "",
            "dinamico": bool(afs),
            "bloques": idiomas.extraer(afs, mapa) if afs else [],
            "assets": idiomas.resumen(afs) if afs else {},
        })

    return {
        "campana": {
            "id": camp["id"], "nombre": camp.get("name", ""),
            "objetivo": camp.get("objective", ""), "estado": camp.get("status", ""),
            "cuenta": norm_account(camp.get("account_id", "")),
            "presupuesto": camp.get("daily_budget") or camp.get("lifetime_budget") or "",
            "cbo": bool(camp.get("daily_budget") or camp.get("lifetime_budget")),
        },
        "adsets": [{
            "id": a["id"], "nombre": a.get("name", ""), "estado": a.get("status", ""),
            "presupuesto": a.get("daily_budget") or a.get("lifetime_budget") or "",
            "diario": bool(a.get("daily_budget")),
            "ads": sum(1 for x in ads if x.get("adset_id") == a["id"]),
            # Vídeos del adset, para poder sustituirlos en los adsets añadidos.
            "videos": _videos_de(a["id"], ads),
        } for a in adsets],
        "ads": lista_ads,
    }


def api_campana_cargar(_q, body):
    """Lee la campaña en segundo plano y devuelve el id del trabajo.

    Una campaña de cien anuncios son varias páginas del Graph API, cada una con
    el `asset_feed_spec` entero, y Meta además impone esperas de 30 y 60 s
    cuando le llegan muchas peticiones seguidas. Eso pasa de los 100 s que
    Cloudflare aguanta, y la petición moría con un 524 sin decir por qué.

    Leyéndola aquí y sondeando el trabajo, el tiempo deja de importar.
    """
    alias = (body.get("alias") or "").strip()
    cid = (body.get("id") or "").strip()
    if not alias or not cid:
        raise ValueError("hacen falta 'alias' y 'id' de la campaña")

    try:
        store.purgar_lecturas()
    except Exception:                            # noqa: BLE001 — no vale fallar por esto
        log.warning("No se pudieron purgar las lecturas antiguas", exc_info=True)

    trabajo_id = store.crear_trabajo({"leer_campana": cid}, body.get("usuario"))

    def tarea():
        try:
            store.anotar(trabajo_id, "Leyendo la campaña en Meta…")
            datos = leer_campana(alias, cid)
            store.anotar(
                trabajo_id,
                "Leídos {} adset(s) y {} anuncio(s)".format(
                    len(datos["adsets"]), len(datos["ads"])),
            )
            store.anadir_resultado(trabajo_id, datos)
            store.cerrar_trabajo(trabajo_id, "done")
        except ApiError as e:
            store.anotar(trabajo_id, "ERROR: {}".format(e.message))
            store.cerrar_trabajo(trabajo_id, "error", e.message)
        except Exception as e:                   # noqa: BLE001
            log.exception("Lectura de campaña %s falló", cid)
            store.anotar(trabajo_id, "ERROR: {}".format(e))
            store.cerrar_trabajo(trabajo_id, "error", str(e))

    threading.Thread(target=tarea, daemon=True).start()
    return {"trabajo": trabajo_id}


def _videos_de(adset_id, ads):
    """Vídeos que usan los anuncios de un adset, con etiqueta y miniatura."""
    salida, vistos = [], set()
    for ad in ads:
        if ad.get("adset_id") != adset_id:
            continue
        afs = (ad.get("creative") or {}).get("asset_feed_spec") or {}
        for v in afs.get("videos") or []:
            vid = v.get("video_id")
            if not vid or vid in vistos:
                continue
            vistos.add(vid)
            salida.append({
                "id": vid,
                "etiquetas": [l.get("name") for l in v.get("adlabels") or [] if l.get("name")],
                "miniatura": v.get("thumbnail_url") or "",
                "anuncio": ad.get("name", ""),
            })
    return salida


def api_historial(q, _b):
    limite = int(q.get("limite", ["100"])[0])
    return {"copias": store.listar_copias(limite)}


def api_clonar(_q, body):
    """Pone la copia en cola y devuelve el id del trabajo.

    No se ejecuta aquí: las clonaciones van de una en una. Dos a la vez se
    pisan el directorio temporal donde se descargan los vídeos —la que termina
    primero lo borra— y además duplican las peticiones a Meta, que ya limita de
    sobra con una sola campaña grande.
    """
    alias_origen = body.get("alias_origen") or ""
    # Se lanza desde una campaña origen O desde una plantilla guardada.
    origen = body.get("campana") or body.get("plantilla")
    destinos = body.get("destinos") or []
    if not alias_origen or not origen or not destinos:
        raise ValueError("hace falta un token, un origen (campaña o plantilla) "
                         "y al menos una cuenta de destino")

    # Las ediciones y los vídeos subidos tienen que sobrevivir a la espera en
    # cola, así que el cuerpo entero se guarda con el trabajo.
    trabajo_id = store.crear_trabajo(
        body, body.get("usuario"), estado="queued", completo=True)
    store.anotar(trabajo_id, "En cola…")
    return {"trabajo": trabajo_id}


def api_trabajos(q, _b):
    """Los trabajos de clonado recientes, para la pantalla de la cola."""
    return {"trabajos": store.listar_trabajos(int(q.get("limite", ["20"])[0]))}


def api_trabajo_cancelar(_q, body):
    """Cancela uno en cola, o pide parar uno en curso."""
    tid = (body.get("id") or "").strip()
    if not tid:
        raise ValueError("hace falta el id del trabajo")
    que_paso = store.cancelar_trabajo(tid)
    if que_paso == "parando":
        store.anotar(tid, "Cancelación pedida: se parará al terminar la cuenta en curso.")
    return {"ok": True, "resultado": que_paso}


def _despachador() -> None:
    """Ejecuta las clonaciones encoladas, de una en una y por orden de llegada.

    Vive en un hilo propio durante toda la vida del proceso. Si el contenedor
    se reinicia, los trabajos que seguían en cola se retoman solos; los que
    estaban a medias quedan en error (ver `reabrir_huerfanos`), porque nadie
    sabe qué llegó a crearse en Meta.
    """
    log.info("Despachador de la cola en marcha")
    while True:
        try:
            trabajo = store.tomar_siguiente()
        except Exception:                        # noqa: BLE001 — la base puede caerse
            log.exception("No se pudo leer la cola")
            time.sleep(10)
            continue

        if not trabajo:
            time.sleep(2)
            continue

        tid = trabajo["id"]
        try:
            body = trabajo["input"] or {}
            log.info("Empezando el trabajo %s", tid)
            _ejecutar_clonado(tid, body)
        except Exception as e:                   # noqa: BLE001
            log.exception("El trabajo %s se cayó entero", tid)
            try:
                store.cerrar_trabajo(tid, "error", str(e))
            except Exception:                    # noqa: BLE001
                pass


def subir_video(alias: str, cuenta: str, nombre: str, datos: bytes) -> Dict[str, Any]:
    """Sube un vídeo a la cuenta destino y espera a que Meta lo procese.

    Se le quitan los metadatos igual que a los que la app copia del origen: si
    no, el archivo que sale de un editor de vídeo llega a Meta con su software,
    sus fechas y a veces el nombre del proyecto.
    """
    g = graph_de(alias)
    datos, limpiado = clonado.limpiar_bytes(datos, nombre)
    res = g.post_files("{}/advideos".format(norm_account(cuenta)),
                       files={"source": (nombre, datos)})
    vid = res.get("id")

    # El vídeo no se puede usar en un anuncio hasta que está 'ready'. Se espera,
    # pero solo 24 s: en opwinners esta petición iba por localhost y podía durar
    # lo que hiciera falta; aquí pasa por Cloudflare, que corta a los 100 s, y
    # entre subirlo y clonar suelen pasar minutos de sobra para que termine.
    estado = clonado.esperar_video_listo(g, vid, intentos=12)
    return {"video_id": vid, "estado": estado, "nombre": nombre, "limpiado": limpiado}


def miniatura_de(alias: str, video_id: str) -> Optional[Tuple[bytes, str]]:
    """Miniatura real de un vídeo, servida por el propio servicio.

    Dos motivos para no usar la `thumbnail_url` del asset_feed_spec: el
    navegador no puede cargarla (Facebook bloquea la carga desde otro origen, la
    imagen queda a 0x0) y además suele ser la misma para varios vídeos, con lo
    que no sirve para distinguirlos.
    """
    with _CANDADO_MINIATURAS:
        if video_id in _MINIATURAS:
            return _MINIATURAS[video_id]
    try:
        g = graph_de(alias)
        info = g.get(str(video_id), fields="picture,thumbnails{uri,is_preferred}")
        miniaturas = (info.get("thumbnails") or {}).get("data") or []
        url = next((t["uri"] for t in miniaturas if t.get("is_preferred")), None)
        if not url:
            url = miniaturas[0]["uri"] if miniaturas else info.get("picture")
        if not url:
            return None
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        dato = (resp.content, resp.headers.get("Content-Type", "image/jpeg"))
        with _CANDADO_MINIATURAS:
            if len(_MINIATURAS) < 400:        # tope para no crecer sin control
                _MINIATURAS[video_id] = dato
        return dato
    except (ApiError, requests.RequestException, KeyError, IndexError, ValueError):
        return None


def _extra_de(adsets_extra: List[Dict[str, Any]], cuenta: str) -> List[Dict[str, Any]]:
    """Deja en cada adset añadido los vídeos que se subieron a ESTA cuenta.

    La web manda `videos` anidado por cuenta destino, porque un `video_id` de
    Meta pertenece a la cuenta donde se subió: pasarle a la segunda cuenta el id
    de la primera dejaría el anuncio colgando de un asset ajeno. El motor espera
    un mapa plano, así que se aplana aquí.

    Se acepta también el formato plano de antes, por si queda alguna petición
    vieja en vuelo.
    """
    salida = []
    for extra in adsets_extra:
        videos = extra.get("videos") or {}
        if videos and all(isinstance(v, dict) for v in videos.values()):
            videos = videos.get(cuenta) or {}
        salida.append({**extra, "videos": videos})
    return salida


def _ejecutar_clonado(trabajo_id: str, body: Dict[str, Any]) -> None:
    def anota(texto: str) -> None:
        store.anotar(trabajo_id, texto)

    try:
        alias_origen = body["alias_origen"]
        campana = body.get("campana") or ""
        destinos = body["destinos"]
        copias = int(body.get("copias") or 1)
        nombre_campana = (body.get("nombre_campana") or "").strip()
        ediciones = body.get("ediciones") or {}
        dry = bool(body.get("dry_run"))
        videos_manuales = body.get("videos") or {}
        usuario = body.get("usuario")

        # Lanzamiento desde plantilla: la estructura sustituye a la campaña origen.
        estructura = None
        plantilla_id = body.get("plantilla")
        if plantilla_id:
            p = store.obtener_plantilla(str(plantilla_id))
            if not p:
                raise ValueError("plantilla no encontrada")
            estructura = p["estructura"]
            campana = p.get("origen_campana") or "plantilla:{}".format(plantilla_id)
            anota("Plantilla: {}".format(p["nombre"]))
            if videos_manuales:
                anota("{} hueco(s) de vídeo rellenados".format(len(videos_manuales)))

        src = graph_de(alias_origen)

        for destino in destinos:
            # Entre cuenta y cuenta es el único punto donde se puede parar sin
            # dejar una campaña a medias: lo ya creado en Meta se queda.
            if store.cancelacion_pedida(trabajo_id):
                anota("Cancelado: no se siguen procesando más cuentas.")
                store.cerrar_trabajo(trabajo_id, "cancelled")
                return

            cuenta = norm_account(destino.get("cuenta", ""))
            alias_destino = destino.get("alias") or alias_origen
            dst = graph_de(alias_destino) if alias_destino != alias_origen else src
            anota("\n{} DESTINO {} {}".format("=" * 20, cuenta, "=" * 20))

            cfg = {
                "SRC_CAMPAIGN_ID": campana,
                "DST_ACCOUNT_ID": cuenta,
                "DST_PAGE_ID": destino.get("page_id") or "",
                "DST_PAGE_NOMBRE": destino.get("page_nombre") or "",
                "DST_INSTAGRAM_ID": destino.get("instagram_id") or "",
                "DST_PIXEL_ID": destino.get("pixel_id") or "",
            }
            motor = clonado.Clonador(
                cfg, src, dst, dry_run=dry, copias=copias,
                nombre_campana=nombre_campana, ediciones=ediciones, progreso=anota,
                copias_por_adset=body.get("copias_por_adset") or {},
                nombres_por_adset=body.get("nombres_por_adset") or {},
                adsets_extra=_extra_de(body.get("adsets_extra") or [], cuenta),
                presupuestos_por_adset=body.get("presupuestos_por_adset") or {},
                presupuesto_campana=body.get("presupuesto_campana") or "",
                un_ad_por_adset=bool(body.get("un_ad_por_adset")),
                forzar_abo=bool(body.get("forzar_abo")),
                presupuesto_abo=body.get("presupuesto_abo") or "",
                estructura=estructura,
                videos_manuales=videos_manuales.get(cuenta) or videos_manuales.get("*") or {},
            )
            try:
                res = motor.ejecutar()
            except ApiError as e:
                anota("ERROR en {}: {}".format(cuenta, e.message))
                store.anadir_resultado(trabajo_id, {"cuenta": cuenta, "error": e.message})
                continue

            if not dry:
                store.registrar_copia({
                    "campana_origen": campana,
                    "nombre_origen": res.get("nombre_origen", ""),
                    "cuenta_origen": res.get("cuenta_origen", ""),
                    "cuenta_destino": cuenta,
                    "nombre_destino": res.get("nombre_campana", ""),
                    "campana_destino": res.get("campana_id", ""),
                    "adsets": res["creados"]["adsets"],
                    "ads": res["creados"]["ads"],
                    "copias_pedidas": copias,
                    "incidencias": res.get("fallos") or [],
                    "detalle": {"avisos": res.get("avisos") or []},
                    "trabajo": trabajo_id,
                    "creado_por": usuario,
                })
            store.anadir_resultado(trabajo_id, {
                "cuenta": cuenta,
                "alias": alias_destino,
                "campana_destino": res.get("campana_id"),
                "creados": res["creados"],
                "fallos": res.get("fallos") or [],
            })

        store.cerrar_trabajo(trabajo_id, "done")
    except Exception as e:                       # noqa: BLE001 — se reporta a la UI
        anota("ERROR: {}".format(e))
        anota(traceback.format_exc()[-800:])
        log.exception("Clonado %s falló", trabajo_id)
        store.cerrar_trabajo(trabajo_id, "error", str(e))
    finally:
        # Los vídeos descargados se comparten entre las cuentas de esta corrida;
        # ya no hacen falta.
        clonado.limpiar_cache_videos()


def api_plantillas_listar(_q, _b):
    return {"plantillas": store.listar_plantillas()}


def api_plantillas_guardar(_q, body):
    """Congela una campaña (con las ediciones de idioma ya aplicadas)."""
    nombre = (body.get("nombre") or "").strip()
    if not nombre:
        raise ValueError("hace falta un nombre para la plantilla")
    g = graph_de(body.get("alias") or "")
    cfg = {"SRC_CAMPAIGN_ID": body.get("campana") or "", "DST_ACCOUNT_ID": "act_0"}
    motor = clonado.Clonador(cfg, g, g)
    datos = motor.leer_origen()

    # Las ediciones se guardan ya aplicadas: la plantilla es el resultado final.
    ediciones = body.get("ediciones") or {}
    for ad in datos["ads"]:
        cambios = ediciones.get(ad.get("id"))
        afs = (ad.get("creative") or {}).get("asset_feed_spec")
        if cambios and afs:
            ad["creative"]["asset_feed_spec"], _ = idiomas.aplicar(afs, cambios)

    # Guardar una campaña sin anuncios da una plantilla inservible: al lanzarla
    # solo crearía adsets vacíos. Suele pasar tras un lanzamiento fallido.
    if not datos["ads"] and not body.get("forzar"):
        raise ValueError(
            "la campaña '{}' no tiene ningún anuncio, así que la plantilla no serviría "
            "para lanzar nada. Suele pasar cuando los anuncios fallaron al crearse: "
            "revisa las incidencias de ese lanzamiento.".format(
                datos["campana"].get("name", "")))

    pid = store.guardar_plantilla(
        nombre, datos,
        origen_campana=body.get("campana") or "",
        origen_cuenta=norm_account(datos["campana"].get("account_id", "")),
        nota=body.get("nota") or "",
        creado_por=body.get("usuario"),
    )
    return {"ok": True, "id": pid,
            "huecos": store.huecos_video(datos["ads"]),
            "ads": len(datos["ads"])}


def api_plantillas_borrar(q, _b):
    store.borrar_plantilla(q.get("id", [""])[0])
    return {"ok": True}


def api_plantilla(q, _b):
    p = store.obtener_plantilla(q.get("id", [""])[0])
    if not p:
        raise ValueError("plantilla no encontrada")
    est = p["estructura"]
    mapa = locales()
    ads = []
    for ad in est.get("ads") or []:
        afs = (ad.get("creative") or {}).get("asset_feed_spec")
        ads.append({
            "id": ad.get("id"), "nombre": ad.get("name", ""),
            "url_tags": (ad.get("creative") or {}).get("url_tags") or "",
            "dinamico": bool(afs),
            "bloques": idiomas.extraer(afs, mapa) if afs else [],
            "assets": idiomas.resumen(afs) if afs else {},
        })
    return {
        "plantilla": {
            "id": p["id"], "nombre": p["nombre"], "nota": p.get("nota") or "",
            "campana": est.get("campana", {}).get("name", ""),
            "objetivo": est.get("campana", {}).get("objective", ""),
            "adsets": len(est.get("adsets") or []),
        },
        "ads": ads,
        "huecos": store.huecos_video(est.get("ads") or []),
    }


def api_pixeles(q, _b):
    g = graph_de(q.get("alias", [""])[0])
    cuenta = norm_account(q.get("cuenta", [""])[0])
    try:
        px = g.get_all("{}/adspixels".format(cuenta), fields="id,name")
    except ApiError:
        px = []
    return {"pixeles": [{"id": p["id"], "nombre": p.get("name", "")} for p in px]}


def api_paginas(q, _b):
    g = graph_de(q.get("alias", [""])[0])
    cuenta = norm_account(q.get("cuenta", [""])[0])
    salida, vistas = [], set()
    # Las páginas asignadas a la cuenta publicitaria son las que de verdad sirven.
    for ruta, campos in (("{}/promote_pages".format(cuenta), "id,name"),
                         ("me/accounts", "id,name")):
        try:
            for p in g.get_all(ruta, fields=campos):
                if p["id"] not in vistas:
                    vistas.add(p["id"])
                    salida.append({"id": p["id"], "nombre": p.get("name", "")})
        except ApiError:
            continue
    return {"paginas": salida}


def api_instagram(q, _b):
    """Cuentas de Instagram utilizables con una página concreta.

    Si la página no tiene ninguna vinculada, Meta usa su cuenta respaldada
    (page-backed Instagram account), así que dejar el campo vacío es válido.
    """
    g = graph_de(q.get("alias", [""])[0])
    page_id = q.get("pagina", [""])[0]
    if not page_id:
        return {"cuentas": []}

    salida, vistas = [], set()

    def anadir(cid, nombre, tipo):
        if cid and cid not in vistas:
            vistas.add(cid)
            salida.append({"id": cid, "nombre": nombre or cid, "tipo": tipo})

    try:
        p = g.get(page_id, fields="instagram_business_account{id,username},"
                                  "connected_instagram_account{id,username}")
        for clave, tipo in (("instagram_business_account", "vinculada"),
                            ("connected_instagram_account", "conectada")):
            cuenta = p.get(clave) or {}
            anadir(cuenta.get("id"), cuenta.get("username"), tipo)
    except ApiError:
        pass

    try:
        for pb in g.get_all("{}/page_backed_instagram_accounts".format(page_id),
                            fields="id,username"):
            anadir(pb.get("id"), pb.get("username"), "respaldada por la página")
    except ApiError:
        pass

    return {"cuentas": salida}


def api_trabajo(q, _b):
    return store.leer_trabajo(q.get("id", [""])[0])


RUTAS_GET = {
    "/api/tokens": api_tokens_listar,
    "/api/cuentas": api_cuentas,
    "/api/campanas": api_campanas,
    "/api/campana": api_campana,
    "/api/historial": api_historial,
    "/api/trabajo": api_trabajo,
    "/api/trabajos": api_trabajos,
    "/api/plantillas": api_plantillas_listar,
    "/api/plantilla": api_plantilla,
    "/api/pixeles": api_pixeles,
    "/api/paginas": api_paginas,
    "/api/instagram": api_instagram,
}

RUTAS_POST = {
    "/api/tokens": api_tokens_guardar,
    "/api/tokens/borrar": api_tokens_borrar,
    "/api/clonar": api_clonar,
    "/api/campana/cargar": api_campana_cargar,
    "/api/trabajos/cancelar": api_trabajo_cancelar,
    "/api/plantillas": api_plantillas_guardar,
    "/api/plantillas/borrar": api_plantillas_borrar,
}


# --------------------------------------------------------------------------
# Servidor
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "WinnersCloner"

    def log_message(self, formato, *args):   # menos ruido: el sondeo es constante
        if "/api/trabajo" not in (self.path or ""):
            log.info("%s %s", self.command, self.path.split("?")[0])

    def _autorizado(self) -> bool:
        """Estar dentro de la red interna no basta: cualquier contenedor de
        `winners-net` la alcanzaría. La app manda un token compartido."""
        if not TOKEN_SERVICIO:
            return False
        return self.headers.get("X-Engine-Token") == TOKEN_SERVICIO

    def _responder(self, codigo: int, cuerpo: bytes, tipo: str) -> None:
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def _json(self, datos: Any, codigo: int = 200) -> None:
        self._responder(codigo, json.dumps(datos, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8")

    def _despachar(self, tabla, ruta, query, body):
        fn = tabla.get(ruta)
        if not fn:
            self._json({"error": "ruta desconocida"}, 404)
            return
        try:
            self._json(fn(query, body))
        except ApiError as e:
            self._json({"error": e.message, "codigo": e.code}, 400)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:                   # noqa: BLE001
            log.exception("Fallo en %s", ruta)
            self._json({"error": "{}: {}".format(type(e).__name__, e)}, 500)

    def do_GET(self):
        partes = urlparse(self.path)

        # Sonda de salud: sin token, para que Docker pueda comprobarla.
        if partes.path == "/salud":
            self._json({"ok": True})
            return

        if not self._autorizado():
            self._json({"error": "no autorizado"}, 401)
            return

        if partes.path == "/api/miniatura":
            q = parse_qs(partes.query)
            dato = miniatura_de(q.get("alias", [""])[0], q.get("video", [""])[0])
            if not dato:
                self._responder(404, b"", "image/jpeg")
                return
            cuerpo, tipo = dato
            self.send_response(200)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(cuerpo)))
            self.send_header("Cache-Control", "max-age=3600")
            self.end_headers()
            self.wfile.write(cuerpo)
            return

        self._despachar(RUTAS_GET, partes.path, parse_qs(partes.query), None)

    def _leer_exacto(self, largo: int) -> bytes:
        """Lee `largo` bytes del socket.

        `rfile.read(n)` puede devolver menos de n con archivos grandes, y un
        vídeo a medias se sube a Meta igual de callado que uno entero.
        """
        trozos = []
        restan = largo
        while restan > 0:
            trozo = self.rfile.read(min(restan, 1 << 20))
            if not trozo:
                break
            trozos.append(trozo)
            restan -= len(trozo)
        return b"".join(trozos)

    def _subida_video(self, query):
        """POST /api/video con el archivo en crudo en el cuerpo.

        Se envía así (y no como multipart) porque el archivo es lo único que
        viaja; el resto de datos van en la query.
        """
        largo = int(self.headers.get("Content-Length") or 0)
        if not largo:
            self._json({"error": "no llegó ningún archivo"}, 400)
            return

        datos = self._leer_exacto(largo)
        nombre = query.get("nombre", ["video.mp4"])[0]

        # El tamaño se registra a propósito: entre el navegador y aquí hay un
        # proxy de Next y Cloudflare, y ambos tienen topes. Si un vídeo llega
        # cortado, esta línea es lo que lo delata.
        log.info("subida: %s — %.1f MB", nombre, len(datos) / 1048576)
        if len(datos) != largo:
            self._json({"error": "el archivo llegó incompleto ({} de {} bytes). "
                                 "Suele ser un tope del proxy: prueba con un vídeo "
                                 "más pequeño.".format(len(datos), largo)}, 400)
            return

        try:
            res = subir_video(
                query.get("alias", [""])[0],
                query.get("cuenta", [""])[0],
                nombre,
                datos,
            )
            if res["estado"] == "error":
                self._json({"error": "Meta no pudo procesar el vídeo"}, 400)
                return
            self._json(res)
        except ApiError as e:
            self._json({"error": e.message}, 400)
        except Exception as e:                   # noqa: BLE001
            log.exception("Fallo subiendo vídeo")
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        partes = urlparse(self.path)
        if not self._autorizado():
            self._json({"error": "no autorizado"}, 401)
            return
        if partes.path == "/api/video":
            self._subida_video(parse_qs(partes.query))
            return
        largo = int(self.headers.get("Content-Length") or 0)
        crudo = self.rfile.read(largo) if largo else b"{}"
        try:
            body = json.loads(crudo.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json({"error": "JSON inválido"}, 400)
            return
        self._despachar(RUTAS_POST, partes.path, parse_qs(partes.query), body)


def main() -> None:
    if not TOKEN_SERVICIO:
        raise SystemExit("Falta CLONER_ENGINE_TOKEN: sin él nadie puede usar el motor")

    # Primero se cierran los que quedaron a medias y SOLO después arranca el
    # despachador: al revés, marcaría como huérfano el que acabara de coger.
    huerfanos = store.reabrir_huerfanos()
    if huerfanos:
        log.warning("%s trabajo(s) quedaron a medias en el reinicio anterior", huerfanos)

    threading.Thread(target=_despachador, daemon=True).start()

    if not shutil.which("ffmpeg"):
        log.warning("ffmpeg no está disponible: los vídeos se subirán SIN limpiar "
                    "metadatos")

    log.info("Motor de clonado escuchando en el puerto %s", PUERTO)
    ThreadingHTTPServer(("0.0.0.0", PUERTO), Handler).serve_forever()


if __name__ == "__main__":
    main()
