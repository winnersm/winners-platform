#!/usr/bin/env bash
#
# CUTOVER de Meta Ads: newappmeta → la app única.
#
# Ejecutar SOLO con el equipo avisado. Durante el proceso nadie puede lanzar
# ni tocar campañas.
#
# Orden y por qué:
#   1. Se apaga newappmeta ANTES de copiar. Si se copiara con la app viva,
#      cualquier cambio hecho durante la copia se perdería sin avisar.
#   2. Se copian los datos y se verifican los conteos.
#   3. Se levanta el worker de duplicaciones en la app nueva. No antes: dos
#      workers sobre la misma cola clonarían los anuncios por duplicado.
#   4. El redirect de ads. → app. lo hace Traefik.
#
# Reversión: `./cutover-meta.sh --revertir` vuelve a encender newappmeta.
# Sus datos quedan intactos; la copia nunca los toca.
#
set -euo pipefail

REPO="/opt/apps/winners-platform/repo"
OLD_APP="/opt/apps/newappmeta"

if [[ "${1:-}" == "--revertir" ]]; then
  echo "=== REVERSIÓN ==="
  echo "Encendiendo newappmeta..."
  (cd "$OLD_APP" && docker compose up -d)
  echo
  echo "newappmeta vuelve a estar en marcha en ads.mastermindwinners.com"
  echo "Los datos de la app nueva se quedan como están; no estorban."
  exit 0
fi

echo "=== CUTOVER DE META ADS ==="
echo
echo "Esto va a:"
echo "  1. APAGAR newappmeta (ads.mastermindwinners.com deja de responder)"
echo "  2. Copiar todos sus datos a la app única"
echo "  3. Arrancar el worker de duplicaciones en la app nueva"
echo
read -rp "¿Seguro? Escribe SI para continuar: " ok
[[ "$ok" == "SI" ]] || { echo "Cancelado."; exit 0; }
echo

# ─── 1. Apagar la app vieja ──────────────────────────────────────────────────
echo "1. Apagando newappmeta..."
(cd "$OLD_APP" && docker compose stop)
echo "   apagada"
echo

# ─── 2. Copiar los datos ─────────────────────────────────────────────────────
echo "2. Copiando datos a producción..."
# La base de newappmeta debe seguir en pie para poder volcarla: se paran las
# apps, no el motor de base de datos.
docker start newappmeta-postgres-1 >/dev/null 2>&1 || true
"${REPO}/packages/db/scripts/migrate-meta-data.sh" winners
echo

# ─── 3. Arrancar el worker ───────────────────────────────────────────────────
echo "3. Arrancando el worker de duplicaciones..."
(cd "${REPO}/infra" && docker compose up -d winners-worker 2>&1 | tail -3)
echo

# ─── 4. Comprobación ─────────────────────────────────────────────────────────
echo "4. Comprobando la app..."
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: app.mastermindwinners.com" -k https://127.0.0.1/login --max-time 20)
echo "   /login → ${code}"
[[ "$code" == "200" ]] || { echo "   LA APP NO RESPONDE — revertir con: $0 --revertir"; exit 1; }

echo
echo "=== CUTOVER COMPLETADO ==="
echo
echo "Queda por hacer a mano:"
echo "  · Redirigir ads.mastermindwinners.com → app.mastermindwinners.com/meta"
echo "    (labels de Traefik en ${OLD_APP} o una Redirect Rule en Cloudflare)"
echo "  · Repartir las contraseñas nuevas desde /admin/users"
echo
echo "Si algo va mal: $0 --revertir"
