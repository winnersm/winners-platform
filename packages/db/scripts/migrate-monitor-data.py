#!/usr/bin/env python3
"""
Migración de link-monitor: ficheros JSON/YAML → schema `monitor`.

Es la única de las cuatro migraciones que no sale de una base de datos: el
monitor guarda su estado en ficheros dentro del contenedor.

    config.yaml      los links vigilados y sus expectativas
    state.json       el estado actual de cada uno
    incidents.jsonl  el histórico de caídas y recuperaciones
    users.json       usuarios del panel (NO se migran: ya están en core.User)

Pasar esto a tablas resuelve además el fallo del bind-mount: config.yaml se
monta como fichero suelto y no se puede reescribir con el patrón habitual de
guardar-y-renombrar, lo que obligó a escribirlo directamente y sin red.

Uso (en el servidor):
    python3 migrate-monitor-data.py winners_staging     ensayo
    python3 migrate-monitor-data.py winners             de verdad
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone

TARGET_DB = sys.argv[1] if len(sys.argv) > 1 else "winners_staging"
SRC_CONTAINER = "link-monitor"
DST_CONTAINER = "winners-pg"


def leer_del_contenedor(ruta: str) -> str:
    """Lee un fichero de dentro del contenedor del monitor."""
    out = subprocess.run(
        ["docker", "exec", SRC_CONTAINER, "cat", ruta],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"No se pudo leer {ruta}: {out.stderr.strip()}")
    return out.stdout


def sql(consulta: str) -> str:
    # ON_ERROR_STOP: sin esto psql devuelve 0 aunque la sentencia falle, y los
    # errores pasan desapercibidos hasta que se cuentan las filas.
    # -q: sin esto, un RETURNING devuelve el valor Y el "INSERT 0 1" pegados.
    out = subprocess.run(
        ["docker", "exec", "-i", DST_CONTAINER, "psql", "-U", "winners",
         "-d", TARGET_DB, "-tA", "-q", "-v", "ON_ERROR_STOP=1"],
        input=consulta, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"SQL falló:\n{out.stderr.strip()}\n--- consulta ---\n{consulta}")
    return out.stdout.strip()


def lit(valor) -> str:
    """Literal SQL. Se escapan las comillas: los nombres traen apóstrofos."""
    if valor is None:
        return "NULL"
    if isinstance(valor, bool):
        return "true" if valor else "false"
    if isinstance(valor, (int, float)):
        return str(valor)
    return "'" + str(valor).replace("'", "''") + "'"


def fecha(valor: str | None) -> str:
    if not valor:
        return "NULL"
    try:
        # Las marcas de tiempo vienen como 2026-06-08T15:56:08Z
        dt = datetime.fromisoformat(valor.replace("Z", "+00:00"))
        return lit(dt.astimezone(timezone.utc).isoformat())
    except ValueError:
        return "NULL"


def main() -> None:
    print(f"=== Migración de Monitor → {TARGET_DB} ===\n")

    # ── 1. Los links vigilados ───────────────────────────────────────────────
    print("1. Leyendo config.yaml...")
    try:
        import yaml  # type: ignore
        config = yaml.safe_load(leer_del_contenedor("/app/config.yaml"))
    except ImportError:
        # El contenedor del monitor sí tiene PyYAML: se usa el suyo para
        # convertir a JSON y así no depender de lo que haya en el host.
        salida = subprocess.run(
            ["docker", "exec", SRC_CONTAINER, "python", "-c",
             "import yaml,json;print(json.dumps(yaml.safe_load(open('/app/config.yaml'))))"],
            capture_output=True, text=True, check=True,
        )
        config = json.loads(salida.stdout)

    links = config.get("links", [])
    defaults = config.get("defaults", {})
    macros = config.get("macro_replacements", {})
    print(f"   {len(links)} links vigilados actualmente")

    # ── 2. Estado actual ─────────────────────────────────────────────────────
    print("2. Leyendo state.json...")
    estado = json.loads(leer_del_contenedor("/app/data/state.json") or "{}")
    print(f"   {len(estado)} con estado guardado")

    # ── 3. Histórico ─────────────────────────────────────────────────────────
    print("3. Leyendo incidents.jsonl...")
    incidentes = []
    for linea in leer_del_contenedor("/app/data/incidents.jsonl").splitlines():
        linea = linea.strip()
        if not linea:
            continue
        try:
            incidentes.append(json.loads(linea))
        except json.JSONDecodeError:
            pass  # una línea corrupta no debe abortar la migración
    print(f"   {len(incidentes)} incidentes")
    print()

    # ── 4. Volcar los links ──────────────────────────────────────────────────
    # Los links que ya no están en config.yaml pero sí en state.json se
    # registran igualmente, DESACTIVADOS. Si no, se perderían cientos de
    # incidentes de histórico junto con ellos. Desactivados no se comprueban,
    # así que no se reactiva nada por accidente.
    vigilados = {l["name"] for l in links}
    retirados = [n for n in estado if n not in vigilados]
    if retirados:
        print(f"   {len(retirados)} links con histórico que ya no se vigilan"
              " — se conservan desactivados")
        links = links + [
            {"name": n, "url": estado[n].get("last_chain", [""])[0] or "", "_retirado": True}
            for n in retirados
        ]

    print("4. Insertando links...")
    id_por_nombre: dict[str, str] = {}

    for link in links:
        nombre = link["name"]
        st = estado.get(nombre, {})
        situacion = st.get("status", "UNKNOWN")
        if situacion not in ("OK", "FAIL"):
            situacion = "UNKNOWN"

        consulta = f"""
        INSERT INTO monitor."MonitoredLink"
          (id, name, url, "expectedUrl", "expectRedirect", "expectedText",
           "maxResponseMs", enabled, status, "lastCheckAt", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid()::text, {lit(nombre)}, {lit(link["url"])},
           {lit(link.get("expected_final"))},
           {lit(bool(link.get("expected_redirect", True)))},
           {lit(link.get("expected_text"))},
           {link.get("max_response_ms", defaults.get("max_response_ms", 10000))},
           {lit(not link.get("_retirado", False))}, {lit(situacion)}::monitor."LinkHealth",
           {fecha(st.get("last_checked"))}, now(), now())
        ON CONFLICT DO NOTHING
        RETURNING id;
        """
        nuevo = sql(consulta)
        if not nuevo:
            nuevo = sql(f'SELECT id FROM monitor."MonitoredLink" WHERE name = {lit(nombre)};')
        id_por_nombre[nombre] = nuevo.strip()

    print(f"   {len(id_por_nombre)} links registrados")

    # ── 5. Última comprobación de cada uno ───────────────────────────────────
    # Se guarda como un Check para que el histórico no empiece en blanco.
    print("5. Insertando la última comprobación de cada link...")
    checks = 0
    for nombre, st in estado.items():
        link_id = id_por_nombre.get(nombre)
        if not link_id or not st.get("last_checked"):
            continue
        situacion = st.get("status", "UNKNOWN")
        if situacion not in ("OK", "FAIL"):
            situacion = "UNKNOWN"
        fallos = st.get("last_failures") or []
        sql(f"""
        INSERT INTO monitor."MonitorCheck"
          ("linkId", "checkedAt", status, "httpStatus", "finalUrl", "responseMs", "failReason", detail)
        VALUES
          ({lit(link_id)}, {fecha(st.get("last_checked"))}, {lit(situacion)}::monitor."LinkHealth",
           {lit(st.get("last_status_final"))}, {lit(st.get("last_final_url"))},
           {lit(st.get("last_response_ms"))},
           {lit(fallos[0] if fallos else None)},
           {lit(json.dumps(fallos) if fallos else None)});
        """)
        checks += 1
    print(f"   {checks} comprobaciones")

    # ── 6. Incidentes ────────────────────────────────────────────────────────
    # El fichero guarda eventos sueltos (FAIL / RECOVERY). Aquí se emparejan:
    # un FAIL abre el incidente y el RECOVERY siguiente del mismo link lo cierra.
    print("6. Emparejando incidentes (FAIL abre, RECOVERY cierra)...")
    abiertos: dict[str, dict] = {}
    creados = 0
    huerfanos = 0

    for ev in incidentes:
        nombre = ev.get("name", "")
        link_id = id_por_nombre.get(nombre)
        if not link_id:
            huerfanos += 1
            continue

        if ev.get("kind") == "FAIL":
            # Un FAIL sobre otro FAIL sin recuperación: se ignora el segundo,
            # sigue siendo la misma caída.
            if nombre not in abiertos:
                abiertos[nombre] = ev
        elif ev.get("kind") == "RECOVERY":
            apertura = abiertos.pop(nombre, None)
            sql(f"""
            INSERT INTO monitor."MonitorIncident"
              (id, "linkId", "openedAt", "closedAt", reason, detail, notified)
            VALUES
              (gen_random_uuid()::text, {lit(link_id)},
               {fecha(apertura.get("ts") if apertura else ev.get("ts"))},
               {fecha(ev.get("ts"))},
               {lit((apertura or ev).get("detail", "")[:200])},
               {lit((apertura or ev).get("detail"))},
               true);
            """)
            creados += 1

    # Los que se quedaron sin recuperación siguen caídos.
    for nombre, ev in abiertos.items():
        sql(f"""
        INSERT INTO monitor."MonitorIncident"
          (id, "linkId", "openedAt", "closedAt", reason, detail, notified)
        VALUES
          (gen_random_uuid()::text, {lit(id_por_nombre[nombre])}, {fecha(ev.get("ts"))}, NULL,
           {lit(ev.get("detail", "")[:200])}, {lit(ev.get("detail"))}, true);
        """)
        creados += 1

    print(f"   {creados} incidentes ({len(abiertos)} siguen abiertos)")
    if huerfanos:
        print(f"   {huerfanos} descartados: son de links que ya no se vigilan")

    # ── 7. Ajustes globales ──────────────────────────────────────────────────
    print("7. Guardando ajustes globales...")
    for clave, valor in [
        ("monitor.defaults", json.dumps(defaults)),
        ("monitor.macro_replacements", json.dumps(macros)),
    ]:
        sql(f"""
        INSERT INTO core."Setting" (key, value, label, section, "updatedAt")
        VALUES ({lit(clave)}, {lit(valor)}, NULL, 'monitor', now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
        """)
    print(f"   defaults y {len(macros)} sustituciones de macros")
    print()

    # ── 8. Verificación ──────────────────────────────────────────────────────
    print("Resultado:")
    for etiqueta, consulta in [
        ("links", 'SELECT count(*) FROM monitor."MonitoredLink";'),
        ("comprobaciones", 'SELECT count(*) FROM monitor."MonitorCheck";'),
        ("incidentes", 'SELECT count(*) FROM monitor."MonitorIncident";'),
        ("caídos ahora", "SELECT count(*) FROM monitor.\"MonitoredLink\" WHERE status = 'FAIL';"),
    ]:
        print(f"   {etiqueta:<16} {sql(consulta)}")

    print(f"\n=== Datos migrados a {TARGET_DB} ===")
    print("\nLos usuarios de users.json NO se migran: ya están en core.User.")


if __name__ == "__main__":
    main()
