#!/usr/bin/env bash
#
# Migración de datos: newappmeta_db → schemas `meta` y `core` de winners.
#
# Cómo funciona:
#   1. Vuelca newappmeta_db completo en un schema temporal (`legacy_meta`)
#      dentro de winners-pg. Así los datos viejos y los nuevos conviven en la
#      misma base y el traspaso es un INSERT ... SELECT verificable.
#   2. Construye un mapa de usuarios viejo→nuevo. Hace falta porque la
#      migración de identidades generó ids nuevos, y los registros de
#      auditoría y de "creado por" apuntan a los antiguos.
#   3. Copia tabla por tabla, en orden de dependencias.
#   4. Compara los conteos de origen y destino.
#
# Es idempotente: ON CONFLICT DO NOTHING en todo. Se puede repetir.
#
# Uso (en el servidor):
#   ./migrate-meta-data.sh winners_staging     ensayo
#   ./migrate-meta-data.sh winners             de verdad
#
set -euo pipefail

TARGET_DB="${1:-winners_staging}"
SRC_CONTAINER="newappmeta-postgres-1"
DST_CONTAINER="winners-pg"
DUMP="/tmp/newappmeta-data-$$.sql"

psql_dst() { docker exec -i "$DST_CONTAINER" psql -U winners -d "$TARGET_DB" "$@"; }

echo "=== Migración de datos de Meta → ${TARGET_DB} ==="
echo

# ─── 1. Volcar el origen en un schema temporal ───────────────────────────────
echo "1. Volcando newappmeta_db..."
docker exec "$SRC_CONTAINER" sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=public --no-owner --no-acl --exclude-table=public._prisma_migrations' \
  > "$DUMP"
echo "   $(wc -l < "$DUMP") líneas"

echo "2. Cargando en el schema legacy_meta..."
psql_dst -q -c "DROP SCHEMA IF EXISTS legacy_meta CASCADE;"
# pg_dump califica todo como `public.`; se reescribe a `legacy_meta.` para que
# los datos viejos entren en su propio schema sin tocar el `public` de winners.
sed -e 's/\bpublic\./legacy_meta./g' \
    -e 's/CREATE SCHEMA legacy_meta;/CREATE SCHEMA legacy_meta;/' \
    -e 's/^CREATE SCHEMA public;/CREATE SCHEMA legacy_meta;/' \
    -e 's/^SET search_path = public/SET search_path = legacy_meta/' \
    "$DUMP" | psql_dst -q -v ON_ERROR_STOP=0 > /tmp/legacy-load-$$.log 2>&1 || true
rm -f "$DUMP"

TABLES=$(psql_dst -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='legacy_meta';")
echo "   ${TABLES} tablas cargadas"
[[ "$TABLES" -gt 5 ]] || { echo "   FALLO: se esperaban más tablas"; exit 1; }
echo

# ─── 2. Mapa de usuarios viejo → nuevo ───────────────────────────────────────
# Se empareja por la parte local del correo: el dominio cambió al unificar
# identidades (victor@grupowinners.com → victor@winnersmastermind.com).
echo "3. Mapeando usuarios antiguos a los nuevos..."
psql_dst -q <<'SQL'
DROP TABLE IF EXISTS legacy_meta.user_map;
CREATE TABLE legacy_meta.user_map AS
SELECT o.id AS old_id, n.id AS new_id, n.email
FROM legacy_meta."User" o
JOIN core."User" n
  ON split_part(lower(o.email), '@', 1) = split_part(lower(n.email), '@', 1);
SQL
psql_dst -tAc 'SELECT count(*) FROM legacy_meta.user_map;' | xargs echo "   usuarios emparejados:"

HUERFANOS=$(psql_dst -tAc "SELECT count(*) FROM legacy_meta.\"User\" o WHERE NOT EXISTS (SELECT 1 FROM legacy_meta.user_map m WHERE m.old_id = o.id);")
[[ "$HUERFANOS" == "0" ]] || echo "   AVISO: ${HUERFANOS} usuario(s) del origen sin equivalente — sus registros quedarán sin autor"
echo

# ─── 3. Copiar los datos ─────────────────────────────────────────────────────
echo "4. Copiando datos..."
psql_dst -q <<'SQL'
-- Tokens de Business Manager. tokenLast4 no existía en el origen.
INSERT INTO meta."BusinessManager"
  (id, name, "bmIdMeta", "systemUserId", "encryptedToken", status, "operationId", "createdAt", "updatedAt")
SELECT id, name, "bmIdMeta", "systemUserId", "encryptedToken", status, "operationId", "createdAt", "updatedAt"
FROM legacy_meta."BusinessManager"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."AdAccount"
  (id, "accountIdMeta", name, currency, "bmId", "lastSynced", "createdAt")
SELECT id, "accountIdMeta", name, currency, "bmId", "lastSynced", "createdAt"
FROM legacy_meta."AdAccount"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."FanpageToken"
  (id, name, "systemUserId", "encryptedToken", status, "operationId", "createdAt", "updatedAt")
SELECT id, name, "systemUserId", "encryptedToken", status, "operationId", "createdAt", "updatedAt"
FROM legacy_meta."FanpageToken"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."Fanpage"
  (id, "pageId", name, category, picture, "bmId", "bmName", "igReal", "igId", "pbiaCheckedAt",
   tasks, "isPublished", "verificationStatus", "activeAds", "adsSyncedAt", "operationId",
   "lastSynced", "createdAt", "updatedAt")
SELECT id, "pageId", name, category, picture, "bmId", "bmName", "igReal", "igId", "pbiaCheckedAt",
       tasks, "isPublished", "verificationStatus", "activeAds", "adsSyncedAt", "operationId",
       "lastSynced", "createdAt", "updatedAt"
FROM legacy_meta."Fanpage"
ON CONFLICT (id) DO NOTHING;

-- "createdBy" se traduce con el mapa; si no hay equivalente queda a NULL en
-- lugar de apuntar a un id inexistente.
INSERT INTO meta."LaunchSheet"
  (id, name, kind, columns, "sortOrder", "operationId", "createdBy", "createdAt", "updatedAt")
SELECT s.id, s.name, s.kind, s.columns, s."sortOrder", s."operationId",
       m.new_id, s."createdAt", s."updatedAt"
FROM legacy_meta."LaunchSheet" s
LEFT JOIN legacy_meta.user_map m ON m.old_id = s."createdBy"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."SheetRow" (id, "sheetId", "sortOrder", data, "createdAt", "updatedAt")
SELECT id, "sheetId", "sortOrder", data, "createdAt", "updatedAt"
FROM legacy_meta."SheetRow"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."Launch"
  (id, "sheetId", status, "mlaNombre", "businessName", "businessId", "adAccount",
   "fanPageId", "fanPage", "fanPageBm", "nameAds", "nameAdsUrl", oferta, "tipoAnuncio",
   strategy, dominios, "urlLanzar", "suffixUrl", "nombrePixel", "pixelId", "tokenEnc",
   notes, "sortOrder", "operationId", "createdBy", "createdAt", "updatedAt")
SELECT l.id, l."sheetId", l.status, l."mlaNombre", l."businessName", l."businessId", l."adAccount",
       l."fanPageId", l."fanPage", l."fanPageBm", l."nameAds", l."nameAdsUrl", l.oferta, l."tipoAnuncio",
       l.strategy, l.dominios, l."urlLanzar", l."suffixUrl", l."nombrePixel", l."pixelId", l."tokenEnc",
       l.notes, l."sortOrder", l."operationId", m.new_id, l."createdAt", l."updatedAt"
FROM legacy_meta."Launch" l
LEFT JOIN legacy_meta.user_map m ON m.old_id = l."createdBy"
ON CONFLICT (id) DO NOTHING;

-- El modelo Job pasó a llamarse MetaJob, con tabla meta.jobs.
INSERT INTO meta.jobs
  (id, type, status, input, output, error, progress, logs, "createdBy", "createdAt", "updatedAt")
SELECT j.id, j.type, j.status, j.input, j.output, j.error, j.progress, j.logs,
       m.new_id, j."createdAt", j."updatedAt"
FROM legacy_meta."Job" j
LEFT JOIN legacy_meta.user_map m ON m.old_id = j."createdBy"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."AccountInsightSnapshot"
  (id, "accountId", "operationId", "datePreset", "accountName", "accountStatus", "bmId",
   data, spend, "syncedAt")
SELECT id, "accountId", "operationId", "datePreset", "accountName", "accountStatus", "bmId",
       data, spend, "syncedAt"
FROM legacy_meta."AccountInsightSnapshot"
ON CONFLICT (id) DO NOTHING;

INSERT INTO meta."ListingSnapshot"
  (id, "operationId", "accountId", kind, "datePreset", data, "syncedAt")
SELECT id, "operationId", "accountId", kind, "datePreset", data, "syncedAt"
FROM legacy_meta."ListingSnapshot"
ON CONFLICT (id) DO NOTHING;

-- La auditoría es transversal: vive en core y ahora lleva el módulo.
-- Los registros cuyo autor ya no existe se conservan con userId NULL: perder
-- el rastro de que algo pasó sería peor que no saber quién lo hizo.
INSERT INTO core."AuditLog"
  (id, "userId", module, action, "entityType", "entityId", payload, "createdAt")
SELECT a.id, m.new_id, 'META', a.action, a."entityType", a."entityId", a.payload, a."createdAt"
FROM legacy_meta."AuditLog" a
LEFT JOIN legacy_meta.user_map m ON m.old_id = a."userId"
ON CONFLICT (id) DO NOTHING;

-- AppConfig pasa a ser configuración global.
INSERT INTO core."Setting" (key, value, label, section, "updatedAt")
SELECT key, value, NULL, 'meta', "updatedAt"
FROM legacy_meta."AppConfig"
ON CONFLICT (key) DO NOTHING;
SQL
echo "   copiado"
echo

# ─── 4. Verificación ─────────────────────────────────────────────────────────
echo "5. Comparando conteos (origen → destino):"
psql_dst -q <<'SQL'
\pset format unaligned
\pset tuples_only on
SQL

compare() { # $1 = tabla origen, $2 = tabla destino
  local src dst
  src=$(psql_dst -tAc "SELECT count(*) FROM legacy_meta.\"$1\";" 2>/dev/null || echo "?")
  dst=$(psql_dst -tAc "SELECT count(*) FROM $2;" 2>/dev/null || echo "?")
  if [[ "$src" == "$dst" ]]; then
    printf "   %-26s %6s → %-6s OK\n" "$1" "$src" "$dst"
  else
    printf "   %-26s %6s → %-6s DIFERENCIA\n" "$1" "$src" "$dst"
    MISMATCH=1
  fi
}

MISMATCH=0
compare "BusinessManager"        'meta."BusinessManager"'
compare "AdAccount"              'meta."AdAccount"'
compare "FanpageToken"           'meta."FanpageToken"'
compare "Fanpage"                'meta."Fanpage"'
compare "LaunchSheet"            'meta."LaunchSheet"'
compare "SheetRow"               'meta."SheetRow"'
compare "Launch"                 'meta."Launch"'
compare "Job"                    "meta.jobs"
compare "AccountInsightSnapshot" 'meta."AccountInsightSnapshot"'
compare "ListingSnapshot"        'meta."ListingSnapshot"'
compare "AuditLog"               'core."AuditLog"'

echo
if [[ $MISMATCH -eq 0 ]]; then
  echo "=== TODO CUADRA — datos migrados a ${TARGET_DB} ==="
else
  echo "=== HAY DIFERENCIAS — revisar antes de dar el cutover por bueno ==="
  exit 1
fi

echo
echo "El schema legacy_meta queda en la base como respaldo consultable."
echo "Se puede borrar cuando el cutover esté confirmado:"
echo "  DROP SCHEMA legacy_meta CASCADE;"
