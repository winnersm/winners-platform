"""
Almacenamiento en Postgres. Sustituye a `almacen.py` y `plantillas.py`, que
guardaban todo en un SQLite local (`datos.db`) junto al código.

Tres cambios respecto al original:

  - Los tokens se guardan **cifrados** (AES-256-GCM, la misma clave maestra que
    core.Secret). Antes estaban en texto plano en un fichero del escritorio.
  - Las plantillas van a jsonb. Alguna pesa medio mega, y en SQLite era un TEXT
    que había que parsear entero para leerle el nombre.
  - Los trabajos en curso dejan de vivir en un diccionario en memoria: un
    reinicio a media clonación dejaba al usuario sin saber qué se había creado
    ya en Meta.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Dict, List, Optional

import psycopg2
import psycopg2.extras
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger(__name__)

IV_LEN = 16
TAG_LEN = 16

# Cómo se llaman los estados de un trabajo de cara al usuario.
ESTADOS = {
    "queued": "en cola",
    "running": "en curso",
    "done": "terminado",
    "error": "error",
    "cancelled": "cancelado",
}


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _cur(conn):
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)


# --- cifrado -------------------------------------------------------------
# Mismo formato que apps/web/src/lib/crypto.ts: iv(16) + authTag(16) + cifrado,
# todo en base64. Si cambia uno, hay que cambiar el otro.

def _key() -> bytes:
    hex_key = os.environ.get("ENCRYPTION_KEY", "")
    if len(hex_key) != 64:
        raise RuntimeError("ENCRYPTION_KEY debe ser un hex de 64 caracteres")
    return bytes.fromhex(hex_key)


def cifrar(texto: str) -> str:
    iv = os.urandom(IV_LEN)
    sellado = AESGCM(_key()).encrypt(iv, texto.encode("utf-8"), None)
    # AESGCM devuelve cifrado+tag; la app los guarda al revés (tag antes).
    cifrado, tag = sellado[:-TAG_LEN], sellado[-TAG_LEN:]
    return base64.b64encode(iv + tag + cifrado).decode("ascii")


def descifrar(b64: str) -> str:
    datos = base64.b64decode(b64)
    iv = datos[:IV_LEN]
    tag = datos[IV_LEN : IV_LEN + TAG_LEN]
    cifrado = datos[IV_LEN + TAG_LEN :]
    return AESGCM(_key()).decrypt(iv, cifrado + tag, None).decode("utf-8")


# --- cache ---------------------------------------------------------------

def cache_guardar(clave: str, valor: Any) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cloner."CloneCache" (key, value, "updatedAt")
                VALUES (%s, %s, now())
                ON CONFLICT (key) DO UPDATE
                  SET value = EXCLUDED.value, "updatedAt" = now()
                """,
                (clave, json.dumps(valor, ensure_ascii=False)),
            )
        conn.commit()
    finally:
        conn.close()


def cache_leer(clave: str) -> Optional[Any]:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute('SELECT value FROM cloner."CloneCache" WHERE key = %s', (clave,))
            fila = cur.fetchone()
    finally:
        conn.close()
    return fila[0] if fila else None


# --- tokens --------------------------------------------------------------

def guardar_token(alias: str, token: str, creado_por: Optional[str] = None) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cloner."CloneToken"
                    (id, alias, "encryptedToken", hint, valid, "createdBy",
                     "createdAt", "updatedAt")
                VALUES (gen_random_uuid()::text, %s, %s, %s, false, %s, now(), now())
                ON CONFLICT (alias) DO UPDATE
                  SET "encryptedToken" = EXCLUDED."encryptedToken",
                      hint = EXCLUDED.hint,
                      valid = false, error = NULL, "checkedAt" = NULL,
                      "updatedAt" = now()
                """,
                (alias, cifrar(token), token[-6:], creado_por),
            )
        conn.commit()
    finally:
        conn.close()


def marcar_token(alias: str, valido: bool, usuario: str = "", usuario_id: str = "",
                 error: str = "") -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE cloner."CloneToken"
                   SET valid = %s, "userName" = %s, "userIdMeta" = %s,
                       error = NULLIF(%s, ''), "checkedAt" = now(), "updatedAt" = now()
                 WHERE alias = %s
                """,
                (valido, usuario or None, usuario_id or None, error, alias),
            )
        conn.commit()
    finally:
        conn.close()


def listar_tokens() -> List[Dict[str, Any]]:
    """Los tokens SIN el secreto: solo lo que hace falta para elegir uno."""
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                """
                SELECT alias, hint, "userName", "userIdMeta", valid, error,
                       "checkedAt", "createdAt"
                  FROM cloner."CloneToken"
                 ORDER BY alias
                """
            )
            filas = cur.fetchall()
    finally:
        conn.close()
    return [
        {
            "alias": f["alias"],
            "token_pista": "..." + (f["hint"] or ""),
            "usuario": f["userName"] or "",
            "usuario_id": f["userIdMeta"] or "",
            "valido": f["valid"],
            "error": f["error"] or "",
            "verificado": f["checkedAt"].isoformat() if f["checkedAt"] else None,
            "creado": f["createdAt"].isoformat() if f["createdAt"] else None,
        }
        for f in filas
    ]


def obtener_token(alias: str) -> Optional[str]:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "encryptedToken" FROM cloner."CloneToken" WHERE alias = %s',
                (alias,),
            )
            fila = cur.fetchone()
    finally:
        conn.close()
    return descifrar(fila[0]) if fila else None


def borrar_token(alias: str) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM cloner."CloneToken" WHERE alias = %s', (alias,))
        conn.commit()
    finally:
        conn.close()


# --- historial -----------------------------------------------------------

def registrar_copia(datos: Dict[str, Any]) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cloner."CloneRun"
                    (id, "sourceCampaign", "sourceName", "sourceAccount",
                     "targetAccount", "targetName", "targetCampaign",
                     adsets, ads, "requestedCopies", "dryRun", issues, detail,
                     "jobId", "createdBy", "createdAt")
                VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, now())
                """,
                (
                    datos.get("campana_origen", ""),
                    datos.get("nombre_origen", ""),
                    datos.get("cuenta_origen", ""),
                    datos.get("cuenta_destino", ""),
                    datos.get("nombre_destino", ""),
                    datos.get("campana_destino", ""),
                    datos.get("adsets", 0),
                    datos.get("ads", 0),
                    datos.get("copias_pedidas", 1),
                    bool(datos.get("dry_run")),
                    json.dumps(datos.get("incidencias") or [], ensure_ascii=False),
                    json.dumps(datos.get("detalle") or {}, ensure_ascii=False),
                    datos.get("trabajo"),
                    datos.get("creado_por"),
                ),
            )
        conn.commit()
    finally:
        conn.close()


def listar_copias(limite: int = 100) -> List[Dict[str, Any]]:
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                """
                SELECT * FROM cloner."CloneRun"
                 ORDER BY "createdAt" DESC
                 LIMIT %s
                """,
                (limite,),
            )
            filas = cur.fetchall()
    finally:
        conn.close()
    return [
        {
            "id": f["id"],
            "fecha": f["createdAt"].isoformat(),
            "campana_origen": f["sourceCampaign"],
            "nombre_origen": f["sourceName"],
            "cuenta_origen": f["sourceAccount"],
            "cuenta_destino": f["targetAccount"],
            "nombre_destino": f["targetName"],
            "campana_destino": f["targetCampaign"],
            "adsets": f["adsets"],
            "ads": f["ads"],
            "copias_pedidas": f["requestedCopies"],
            "dry_run": f["dryRun"],
            "incidencias": f["issues"] or [],
            "detalle": f["detail"] or {},
        }
        for f in filas
    ]


# --- plantillas ----------------------------------------------------------

def huecos_video(ads: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Los vídeos de la plantilla, como huecos rellenables.

    Se agrupan por video_id original: un mismo vídeo suele servir a varios
    idiomas y a varios anuncios, y debe rellenarse una sola vez.
    """
    huecos: Dict[str, Dict[str, Any]] = {}

    def hueco(vid_id: str) -> Dict[str, Any]:
        return huecos.setdefault(
            vid_id, {"video_id_original": vid_id, "etiquetas": [], "anuncios": []}
        )

    for ad in ads:
        creative = ad.get("creative") or {}
        nombre_ad = ad.get("name") or ad.get("id")

        for vid in (creative.get("asset_feed_spec") or {}).get("videos") or []:
            vid_id = vid.get("video_id")
            if not vid_id:
                continue
            h = hueco(vid_id)
            for lb in vid.get("adlabels") or []:
                if lb.get("name") and lb["name"] not in h["etiquetas"]:
                    h["etiquetas"].append(lb["name"])
            if nombre_ad not in h["anuncios"]:
                h["anuncios"].append(nombre_ad)

        # Vídeos fuera del feed dinámico (creative clásico)
        vid_id = ((creative.get("object_story_spec") or {}).get("video_data") or {}).get("video_id")
        if vid_id:
            h = hueco(vid_id)
            if nombre_ad not in h["anuncios"]:
                h["anuncios"].append(nombre_ad)

    return list(huecos.values())


def guardar_plantilla(nombre: str, estructura: Dict[str, Any], origen_campana: str = "",
                      origen_cuenta: str = "", nota: str = "",
                      creado_por: Optional[str] = None) -> str:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cloner."CloneTemplate"
                    (id, name, note, "sourceCampaignId", "sourceAccountId", structure,
                     "createdBy", "createdAt", "updatedAt")
                VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (name) DO UPDATE
                  SET structure = EXCLUDED.structure,
                      note = EXCLUDED.note,
                      "sourceCampaignId" = EXCLUDED."sourceCampaignId",
                      "sourceAccountId" = EXCLUDED."sourceAccountId",
                      "updatedAt" = now()
                RETURNING id
                """,
                (nombre, nota, origen_campana, origen_cuenta,
                 json.dumps(estructura, ensure_ascii=False), creado_por),
            )
            nuevo = cur.fetchone()[0]
        conn.commit()
        return nuevo
    finally:
        conn.close()


def listar_plantillas() -> List[Dict[str, Any]]:
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                """
                SELECT id, name, note, "sourceCampaignId", "sourceAccountId",
                       structure, "createdAt"
                  FROM cloner."CloneTemplate"
                 ORDER BY "createdAt" DESC
                """
            )
            filas = cur.fetchall()
    finally:
        conn.close()

    salida = []
    for f in filas:
        est = f["structure"] or {}
        ads = est.get("ads") or []
        salida.append({
            "id": f["id"],
            "nombre": f["name"],
            "nota": f["note"] or "",
            "creada": f["createdAt"].isoformat(),
            "origen_campana": f["sourceCampaignId"],
            "origen_cuenta": f["sourceAccountId"],
            "adsets": len(est.get("adsets") or []),
            "ads": len(ads),
            "huecos": huecos_video(ads),
            "objetivo": (est.get("campana") or {}).get("objective", ""),
        })
    return salida


def obtener_plantilla(plantilla_id: str) -> Optional[Dict[str, Any]]:
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                'SELECT * FROM cloner."CloneTemplate" WHERE id = %s', (plantilla_id,)
            )
            f = cur.fetchone()
    finally:
        conn.close()
    if not f:
        return None
    return {
        "id": f["id"],
        "nombre": f["name"],
        "nota": f["note"] or "",
        "origen_campana": f["sourceCampaignId"],
        "origen_cuenta": f["sourceAccountId"],
        "estructura": f["structure"] or {},
    }


def borrar_plantilla(plantilla_id: str) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM cloner."CloneTemplate" WHERE id = %s', (plantilla_id,))
        conn.commit()
    finally:
        conn.close()


# --- trabajos ------------------------------------------------------------

def crear_trabajo(entrada: Dict[str, Any], creado_por: Optional[str] = None,
                  estado: str = "running", completo: bool = False) -> str:
    """Registra un trabajo. Las clonaciones nacen en 'queued' y las coge el
    despachador; las lecturas de campaña arrancan ya en 'running' porque no
    hacen cola: son rápidas y no tocan nada."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cloner."CloneJob"
                    (id, status, lines, results, input, "createdBy", "createdAt", "updatedAt")
                VALUES (gen_random_uuid()::text, %s, '[]', '[]', %s, %s, now(), now())
                RETURNING id
                """,
                (estado,
                 json.dumps(entrada if completo else _sin_secretos(entrada),
                            ensure_ascii=False),
                 creado_por),
            )
            tid = cur.fetchone()[0]
        conn.commit()
        return tid
    finally:
        conn.close()


def tomar_siguiente() -> Optional[Dict[str, Any]]:
    """Coge el trabajo encolado más antiguo y lo marca en curso.

    `SKIP LOCKED` para que dos despachadores —durante un despliegue conviven
    el contenedor viejo y el nuevo unos segundos— nunca cojan el mismo.
    """
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                """
                UPDATE cloner."CloneJob"
                   SET status = 'running', "updatedAt" = now()
                 WHERE id = (
                        SELECT id FROM cloner."CloneJob"
                         WHERE status = 'queued'
                         ORDER BY "createdAt"
                         FOR UPDATE SKIP LOCKED
                         LIMIT 1)
                RETURNING id, input, "createdBy"
                """
            )
            fila = cur.fetchone()
        conn.commit()
        return dict(fila) if fila else None
    finally:
        conn.close()


def cancelar_trabajo(trabajo_id: str) -> str:
    """Cancela un trabajo. Devuelve qué pasó, para poder decírselo al usuario.

    Uno en cola se cancela sin más. Uno en curso se marca, y el motor lo
    comprueba antes de pasar a la siguiente cuenta: lo que ya haya creado en
    Meta se queda —no hay forma de deshacerlo— pero no sigue.
    """
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                """
                UPDATE cloner."CloneJob"
                   SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
                       "cancelRequested" = true,
                       "finishedAt" = CASE WHEN status = 'queued' THEN now() ELSE "finishedAt" END,
                       "updatedAt" = now()
                 WHERE id = %s AND status IN ('queued', 'running')
                RETURNING status
                """,
                (trabajo_id,),
            )
            fila = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not fila:
        return "nada"                       # ya había terminado
    return "cancelado" if fila["status"] == "cancelled" else "parando"


def cancelacion_pedida(trabajo_id: str) -> bool:
    """¿Alguien ha pedido parar este trabajo? Se mira entre cuenta y cuenta."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "cancelRequested" FROM cloner."CloneJob" WHERE id = %s',
                (trabajo_id,),
            )
            fila = cur.fetchone()
    finally:
        conn.close()
    return bool(fila and fila[0])


def _sin_secretos(entrada: Dict[str, Any]) -> Dict[str, Any]:
    """Recorta la entrada de los trabajos que NO hay que poder repetir.

    Una clonación se guarda entera (`completo=True`) porque espera en cola y
    luego hay que ejecutarla tal cual. Una lectura de campaña no: ahí las
    ediciones solo serían peso muerto.
    """
    copia = dict(entrada)
    copia.pop("ediciones", None)
    return copia


def purgar_lecturas(horas: int = 6) -> int:
    """Borra los trabajos de lectura de campaña ya terminados.

    Cada uno guarda la campaña entera —con cien anuncios y sus veinte idiomas
    son varios MB— y no sirve de nada en cuanto la web tiene los datos. Las
    clonaciones NO se tocan: su registro es el histórico de lo que se creó.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM cloner."CloneJob"
                 WHERE input ? 'leer_campana'
                   AND status <> 'running'
                   AND "createdAt" < now() - make_interval(hours => %s)
                """,
                (horas,),
            )
            n = cur.rowcount
        conn.commit()
        return n
    finally:
        conn.close()


def anotar(trabajo_id: str, texto: str) -> None:
    """Añade una línea al registro del trabajo.

    Se hace con `||` sobre el jsonb en vez de leer-modificar-escribir: el motor
    anota desde un hilo mientras la web va leyendo, y así no se pierde ninguna.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE cloner."CloneJob"
                   SET lines = lines || %s::jsonb, "updatedAt" = now()
                 WHERE id = %s
                """,
                (json.dumps([texto], ensure_ascii=False), trabajo_id),
            )
        conn.commit()
    finally:
        conn.close()


def anadir_resultado(trabajo_id: str, resultado: Dict[str, Any]) -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE cloner."CloneJob"
                   SET results = results || %s::jsonb, "updatedAt" = now()
                 WHERE id = %s
                """,
                (json.dumps([resultado], ensure_ascii=False), trabajo_id),
            )
        conn.commit()
    finally:
        conn.close()


def cerrar_trabajo(trabajo_id: str, estado: str, error: str = "") -> None:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE cloner."CloneJob"
                   SET status = %s, error = NULLIF(%s, ''),
                       "finishedAt" = now(), "updatedAt" = now()
                 WHERE id = %s
                """,
                (estado, error, trabajo_id),
            )
        conn.commit()
    finally:
        conn.close()


def leer_trabajo(trabajo_id: str) -> Dict[str, Any]:
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute('SELECT * FROM cloner."CloneJob" WHERE id = %s', (trabajo_id,))
            f = cur.fetchone()
    finally:
        conn.close()
    if not f:
        return {"estado": "desconocido", "lineas": [], "resultados": []}
    return {
        "estado": ESTADOS.get(f["status"], f["status"]),
        "lineas": f["lines"] or [],
        "resultados": f["results"] or [],
        # "fallo" y no "error": el cliente trata un `error` en el cuerpo como
        # "la petición no se pudo atender" y lanza. Un trabajo que terminó mal
        # SÍ se pudo atender, y su consola es justo lo que hay que poder leer.
        "fallo": f["error"] or "",
    }


def listar_trabajos(limite: int = 20) -> List[Dict[str, Any]]:
    """Los trabajos de clonado recientes, para la pantalla de la cola.

    Sin `lines` ni `results`: una clonación larga son cientos de líneas y la
    campaña leída son megas; eso se pide solo al abrir uno concreto.
    """
    conn = _conn()
    try:
        with _cur(conn) as cur:
            cur.execute(
                """
                SELECT j.id, j.status, j.error, j.input, j."createdAt", j."finishedAt",
                       j."cancelRequested",
                       jsonb_array_length(j.lines)   AS n_lineas,
                       jsonb_array_length(j.results) AS n_resultados,
                       u.name AS autor_nombre, u.email AS autor_email
                  FROM cloner."CloneJob" j
                  LEFT JOIN core."User" u ON u.id = j."createdBy"
                 WHERE NOT (j.input ? 'leer_campana')
                 ORDER BY j."createdAt" DESC
                 LIMIT %s
                """,
                (limite,),
            )
            filas = cur.fetchall()
    finally:
        conn.close()

    salida = []
    for f in filas:
        entrada = f["input"] or {}
        destinos = entrada.get("destinos") or []
        salida.append({
            "id": f["id"],
            "estado": ESTADOS.get(f["status"], f["status"]),
            "error": f["error"] or "",
            "parando": bool(f["cancelRequested"]) and f["status"] == "running",
            "creado": f["createdAt"].isoformat(),
            "terminado": f["finishedAt"].isoformat() if f["finishedAt"] else None,
            "autor": f["autor_nombre"] or f["autor_email"] or "",
            "lineas": f["n_lineas"] or 0,
            "resultados": f["n_resultados"] or 0,
            # Para poder reconocer el trabajo sin abrirlo.
            "campana": entrada.get("campana") or "",
            "nombre_campana": entrada.get("nombre_campana") or "",
            "plantilla": entrada.get("plantilla") or "",
            "cuentas": [d.get("cuenta", "") for d in destinos],
            "dry_run": bool(entrada.get("dry_run")),
        })
    return salida


def reabrir_huerfanos() -> int:
    """Marca como error los trabajos que se quedaron 'running' al reiniciar.

    Sin esto, un trabajo interrumpido se queda girando para siempre en la
    pantalla y nadie sabe si sigue creando cosas en Meta.
    """
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE cloner."CloneJob"
                   SET status = 'error',
                       error = 'El servicio se reinició mientras corría. Revisa en Meta '
                               'qué se llegó a crear antes de volver a lanzarlo.',
                       "finishedAt" = now(), "updatedAt" = now()
                 WHERE status = 'running'
                """
            )
            n = cur.rowcount
        conn.commit()
        return n
    finally:
        conn.close()
