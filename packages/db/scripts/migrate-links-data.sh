#!/usr/bin/env bash
#
# Migración de datos: acortador → schema `links` de winners.
#
# Mismo método que la de Meta: se vuelca el origen en un schema temporal
# (`legacy_links`) dentro de la misma base y se traspasa con INSERT ... SELECT,
# que es verificable y repetible.
#
# MetaConnection no se migra: su token cifrado pasa a core.Secret, que es el
# único sitio donde deben vivir los secretos a partir de ahora. Se avisa si
# hay alguno pendiente de mover a mano.
#
# Uso (en el servidor):
#   ./migrate-links-data.sh winners_staging     ensayo
#   ./migrate-links-data.sh winners             de verdad
#
set -euo pipefail

TARGET_DB="${1:-winners_staging}"
SRC_CONTAINER="acortador-pg"
DST_CONTAINER="winners-pg"
DUMP="/tmp/acortador-data-$$.sql"

psql_dst() { docker exec -i "$DST_CONTAINER" psql -U winners -d "$TARGET_DB" "$@"; }

echo "=== Migración de datos de Links → ${TARGET_DB} ==="
echo

echo "1. Volcando la base del acortador..."
docker exec "$SRC_CONTAINER" sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --schema=public --no-owner --no-acl --exclude-table=public._prisma_migrations' \
  > "$DUMP"
echo "   $(wc -l < "$DUMP") líneas"

echo "2. Cargando en el schema legacy_links..."
psql_dst -q -c "DROP SCHEMA IF EXISTS legacy_links CASCADE;"
sed -e 's/\bpublic\./legacy_links./g' \
    -e 's/^CREATE SCHEMA public;/CREATE SCHEMA legacy_links;/' \
    -e 's/^SET search_path = public/SET search_path = legacy_links/' \
    "$DUMP" | psql_dst -q -v ON_ERROR_STOP=0 > /dev/null 2>&1 || true
rm -f "$DUMP"

TABLES=$(psql_dst -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='legacy_links';")
echo "   ${TABLES} tablas cargadas"
[[ "$TABLES" -ge 3 ]] || { echo "   FALLO: se esperaban al menos 3 tablas"; exit 1; }
echo

echo "3. Copiando datos..."
psql_dst -q <<'SQL'
INSERT INTO links."Domain"
  (id, host, active, verified, "verifiedAt", "lastIps", "createdAt")
SELECT id, host, active, verified, "verifiedAt", "lastIps", "createdAt"
FROM legacy_links."Domain"
ON CONFLICT (id) DO NOTHING;

INSERT INTO links."FunnelUrl" (id, name, "urlTemplate", "createdAt", "updatedAt")
SELECT id, name, "urlTemplate", "createdAt", "updatedAt"
FROM legacy_links."FunnelUrl"
ON CONFLICT (id) DO NOTHING;

-- operationId y createdBy son nuevos: el acortador no tenía multi-tenant ni
-- usuarios propios (iba con una contraseña compartida en Traefik). Quedan a
-- NULL, que significa "de todas las operaciones".
INSERT INTO links."Link"
  (id, slug, "domainId", "funnelUrlId", "targetUrl", "adId", "adsetId", "campaignId",
   "assetId", "adName", "campaignName", active, clicks, "createdAt", "updatedAt")
SELECT id, slug, "domainId", "funnelUrlId", "targetUrl", "adId", "adsetId", "campaignId",
       "assetId", "adName", "campaignName", active, clicks, "createdAt", "updatedAt"
FROM legacy_links."Link"
ON CONFLICT (id) DO NOTHING;
SQL
echo "   copiado"
echo

echo "4. Comparando conteos (origen → destino):"
MISMATCH=0
compare() {
  local src dst
  src=$(psql_dst -tAc "SELECT count(*) FROM legacy_links.\"$1\";" 2>/dev/null || echo "?")
  dst=$(psql_dst -tAc "SELECT count(*) FROM $2;" 2>/dev/null || echo "?")
  if [[ "$src" == "$dst" ]]; then
    printf "   %-16s %6s → %-6s OK\n" "$1" "$src" "$dst"
  else
    printf "   %-16s %6s → %-6s DIFERENCIA\n" "$1" "$src" "$dst"
    MISMATCH=1
  fi
}
compare "Domain"    'links."Domain"'
compare "FunnelUrl" 'links."FunnelUrl"'
compare "Link"      'links."Link"'
echo

# El token de Meta del acortador estaba cifrado con SU propia clave; no se
# puede recifrar aquí sin descifrarlo primero. Se avisa para hacerlo a mano
# desde /admin/secrets, que es donde debe acabar.
CONNS=$(psql_dst -tAc "SELECT count(*) FROM legacy_links.\"MetaConnection\";" 2>/dev/null || echo "0")
if [[ "$CONNS" != "0" ]]; then
  echo "AVISO: hay ${CONNS} conexión(es) de Meta en el acortador."
  echo "  Su token está cifrado con la clave del acortador, distinta de la maestra."
  echo "  Hay que volver a introducirlo desde /admin/secrets tras el cutover."
  echo
fi

if [[ $MISMATCH -eq 0 ]]; then
  echo "=== TODO CUADRA — datos migrados a ${TARGET_DB} ==="
else
  echo "=== HAY DIFERENCIAS — revisar antes de continuar ==="
  exit 1
fi
