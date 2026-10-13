#!/usr/bin/env bash
#
# Migración de datos: automations-hub → schema `automations` de winners.
#
# Además de copiar el histórico, aquí ocurre el cambio de fondo del módulo:
#
#   · La tabla `jobs` (4 tareas con nombre y cron) pasa a `automation_tasks`,
#     donde `enabled`, `cron` y el alcance de cuentas SÍ los obedece el worker.
#     Hoy los horarios están escritos a mano en el código del worker y el
#     on/off por tarea ni se consulta: solo funciona el interruptor general.
#
#   · La tabla `config` se disuelve: lo secreto va a core.Secret y el resto a
#     core.Setting. Hoy los tokens de Meta y las API keys de afiliados están
#     en texto plano, marcados con un booleano `is_secret`.
#
# Uso (en el servidor):
#   ./migrate-automations-data.sh winners_staging     ensayo
#   ./migrate-automations-data.sh winners             de verdad
#
set -euo pipefail

TARGET_DB="${1:-winners_staging}"
SRC_CONTAINER="automations-db"
DST_CONTAINER="winners-pg"
DUMP="/tmp/automations-data-$$.sql"

psql_dst() { docker exec -i "$DST_CONTAINER" psql -U winners -d "$TARGET_DB" "$@"; }

echo "=== Migración de datos de Automations → ${TARGET_DB} ==="
echo

echo "1. Volcando la base de automations-hub..."
docker exec "$SRC_CONTAINER" sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --schema=public --no-owner --no-acl --exclude-table=public._prisma_migrations' \
  > "$DUMP"
echo "   $(wc -l < "$DUMP") líneas"

echo "2. Cargando en el schema legacy_automations..."
psql_dst -q -c "DROP SCHEMA IF EXISTS legacy_automations CASCADE;"
sed -e 's/\bpublic\./legacy_automations./g' \
    -e 's/^CREATE SCHEMA public;/CREATE SCHEMA legacy_automations;/' \
    -e 's/^SET search_path = public/SET search_path = legacy_automations/' \
    "$DUMP" | psql_dst -q -v ON_ERROR_STOP=0 > /dev/null 2>&1 || true
rm -f "$DUMP"

TABLES=$(psql_dst -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='legacy_automations';")
echo "   ${TABLES} tablas cargadas"
[[ "$TABLES" -ge 5 ]] || { echo "   FALLO: se esperaban al menos 5 tablas"; exit 1; }
echo

echo "3. Copiando tareas y su histórico..."
psql_dst -q <<'SQL'
-- Las tareas. El cron viene de la tabla vieja, pero OJO: ese valor era
-- decorativo (el worker lo tenía escrito en el código). Los valores reales
-- del worker se fijan más abajo, para que lo que se ve sea lo que ocurre.
INSERT INTO automations.automation_tasks
  (name, "displayName", description, cron, timezone, enabled, "scopeMode",
   "scopeAccounts", params, "dryRun", "createdAt", "updatedAt")
SELECT name,
       COALESCE(display_name, name),
       description,
       COALESCE(cron, '0 * * * *'),
       'America/Bogota',
       COALESCE(enabled, true),
       'ALL',          -- comportamiento actual: todas las cuentas del token
       '{}',
       '{}'::jsonb,
       false,
       now(), now()
FROM legacy_automations.jobs
ON CONFLICT (name) DO NOTHING;

-- Histórico de ejecuciones. Solo las de tareas que existen: el worker cambió
-- de nombres por el camino (update_sheet pasó a live_tracker y
-- update_sheet_daily) y hay filas huérfanas.
INSERT INTO automations.task_runs
  (id, "taskName", "startedAt", "finishedAt", success, "errorMsg", result,
   "durationS", "triggeredBy", "dryRun")
SELECT r.id, r.job_name, r.started_at, r.finished_at, r.success, r.error_msg,
       r.result, r.duration_s, COALESCE(r.triggered_by, 'scheduler'), false
FROM legacy_automations.job_runs r
WHERE EXISTS (SELECT 1 FROM automations.automation_tasks t WHERE t.name = r.job_name)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('automations.task_runs', 'id'),
              GREATEST((SELECT COALESCE(max(id), 1) FROM automations.task_runs), 1));

INSERT INTO automations.account_snapshots
  (id, "checkedAt", "accountId", "accountName", "statusCode", "statusLabel",
   level, balance, currency, "errorMsg")
SELECT id, checked_at, account_id, account_name, status_code, status_label,
       level, balance, currency, error_msg
FROM legacy_automations.account_snapshots
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('automations.account_snapshots', 'id'),
              GREATEST((SELECT COALESCE(max(id), 1) FROM automations.account_snapshots), 1));

INSERT INTO automations.billing_alerts
  (id, "alertedAt", "accountId", "accountName", "alertType", message, "resolvedAt")
SELECT id, alerted_at, account_id, account_name, alert_type, message, resolved_at
FROM legacy_automations.billing_alerts
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('automations.billing_alerts', 'id'),
              GREATEST((SELECT COALESCE(max(id), 1) FROM automations.billing_alerts), 1));

-- El interruptor general.
INSERT INTO automations.system_flags (key, value, "updatedAt")
SELECT key, value, now() FROM legacy_automations.system_flags
ON CONFLICT (key) DO NOTHING;
SQL
echo "   copiado"
echo

# ─── Horarios reales ─────────────────────────────────────────────────────────
# Estos son los cron que el worker tenía escritos en main.py. Se guardan en la
# base para que el panel muestre la verdad y para que el worker los lea de ahí.
echo "4. Fijando los horarios que el worker usa de verdad..."
psql_dst -q <<'SQL'
INSERT INTO automations.automation_tasks
  (name, "displayName", description, cron, timezone, enabled, "scopeMode", "scopeAccounts", params, "dryRun", "createdAt", "updatedAt")
VALUES
  ('billing_check', 'Revisión de saldo',
   'Comprueba el estado y el saldo de las cuentas de Meta Ads',
   '*/30 * * * *', 'America/Bogota', true, 'ALL', '{}', '{}'::jsonb, false, now(), now()),
  ('live_tracker', 'Gasto intradía',
   'Actualiza el Google Sheet de gasto e ingresos durante el día',
   '1,31 7-19 * * *', 'America/Bogota', true, 'ALL', '{}', '{}'::jsonb, false, now(), now()),
  ('update_sheet_daily', 'Gasto diario',
   'Cierre diario del Google Sheet de gasto e ingresos',
   '0 6 * * *', 'America/Bogota', true, 'ALL', '{}', '{}'::jsonb, false, now(), now()),
  ('meta_autopause', 'Pausa automática',
   'Pausa campañas sin conversiones que superan el gasto mínimo',
   '0 8 * * *', 'America/Bogota', true, 'ALL', '{}',
   '{"lookback_days":7,"min_spend_usd":100,"min_traffic_days":3}'::jsonb, false, now(), now()),
  ('meta_disapproved_cleanup', 'Limpieza de rechazados',
   'Borra anuncios rechazados y los conjuntos que quedan vacíos',
   '0 7 * * *', 'America/Bogota', true, 'ALL', '{}', '{}'::jsonb, false, now(), now())
ON CONFLICT (name) DO UPDATE
  SET cron = EXCLUDED.cron,
      "displayName" = EXCLUDED."displayName",
      description = EXCLUDED.description,
      params = CASE WHEN automations.automation_tasks.params = '{}'::jsonb
                    THEN EXCLUDED.params ELSE automations.automation_tasks.params END,
      "updatedAt" = now();
SQL
psql_dst -tAc "SELECT count(*) FROM automations.automation_tasks;" | xargs echo "   tareas registradas:"
echo

echo "5. Comparando conteos (origen → destino):"
MISMATCH=0
compare() {
  local src dst
  src=$(psql_dst -tAc "SELECT count(*) FROM legacy_automations.$1;" 2>/dev/null || echo "?")
  dst=$(psql_dst -tAc "SELECT count(*) FROM $2;" 2>/dev/null || echo "?")
  if [[ "$src" == "$dst" ]]; then
    printf "   %-20s %6s → %-6s OK\n" "$1" "$src" "$dst"
  else
    printf "   %-20s %6s → %-6s revisar\n" "$1" "$src" "$dst"
    MISMATCH=1
  fi
}
compare "account_snapshots" "automations.account_snapshots"
compare "billing_alerts"    "automations.billing_alerts"
compare "job_runs"          "automations.task_runs"
echo

if [[ $MISMATCH -ne 0 ]]; then
  echo "   (Las diferencias en job_runs son esperables: se descartan las"
  echo "    ejecuciones de tareas que ya no existen con ese nombre.)"
  psql_dst -tAc "SELECT job_name, count(*) FROM legacy_automations.job_runs r WHERE NOT EXISTS (SELECT 1 FROM automations.automation_tasks t WHERE t.name = r.job_name) GROUP BY 1;" | sed 's/^/     descartadas: /'
  echo
fi

echo "=== Datos migrados a ${TARGET_DB} ==="
echo
echo "PENDIENTE a mano tras el cutover: los secretos de la tabla config"
echo "(tokens de Meta, API keys de afiliados, webhooks de Slack) hay que"
echo "volver a introducirlos en /admin/secrets. Estaban en texto plano;"
echo "copiarlos automáticamente sería arrastrar el problema."
psql_dst -tAc "SELECT count(*) FROM legacy_automations.config WHERE is_secret AND value <> '';" | xargs echo "  secretos pendientes de trasladar:"
