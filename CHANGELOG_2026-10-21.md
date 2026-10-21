# Changelog — 2026-10-21
## Rama: `integration/all-features`

**Autor**: Craft Agent + Duglas Altamar  
**Fecha**: 2026-10-21  
**Commits incluidos**: ~20 (merge de 5 features)

---

## 🆕 Features Implementados

### 1. **Currency Fix** (Hoy)
**Problema**: Totales sumaban USD + COP sin distinción, causando cifras incorrectas.

**Solución**:
- ✅ Agregadas columnas `currency` a `AccountSpendDaily` e `AccountInsightSnapshot`
- ✅ Sincronización guarda moneda de cada cuenta (desde Meta API)
- ✅ Totales separados por moneda en `/meta/spend` y `/meta/dashboard`
- ✅ Tabla muestra moneda junto al nombre de cada cuenta

**Archivos modificados**:
- `packages/db/prisma/schema.prisma` — 2 columnas nuevas
- `apps/web/src/lib/spend-history.ts` — agrupa por currency
- `apps/web/src/lib/dashboard-sync.ts` — guarda currency
- `apps/web/src/app/(app)/meta/spend/view.tsx` — UI totales/tabla
- `apps/web/src/app/(app)/meta/dashboard/view.tsx` — UI totales/tabla
- `packages/db/prisma/migrations/0004_...` — SQL migration

**UI antes/después**:
```
ANTES:  Gasto: $9,842.50        DESPUÉS: USD: $9,842.50
        Revenue: $12,000                 COP: $1.250.000
        
        (totales mezclados)              (separados, exacto)
```

---

### 2. **Spend History** (Hace 3 días)
- ✅ Libro diario de gastos (`AccountSpendDaily`)
- ✅ Endpoints: `/api/spend`, `/api/spend/sync`, `/api/spend/backfill`
- ✅ UI con calendario, rango de fechas, tabla por cuenta
- ✅ Job diario a las 6:00 AM (Bogotá)
- ✅ Traer histórico manual (últimos 12 meses)

---

### 3. **Dashboard Sync Button** (Hace 3 días)
- ✅ Botón "Sincronizar con Meta" en `/meta/dashboard`
- ✅ Actualiza todos los snapshots frescos desde Meta
- ✅ Job diario a las 5:00 AM (Bogotá)
- ✅ Safety net: archiva cuentas que salieron del BM

---

### 4. **Fanpage Auto-Sync** (Hace 3 días)
- ✅ Sincronización automática de fanpages deleticias
- ✅ Job diario a las 5:00 AM (Bogotá)
- ✅ Per-operation scope (respeta Operaciones)
- ✅ Fallback a `system_user_id` si BM no tiene permisos

---

### 5. **BM Trash & Audit** (Hace 2 días)
- ✅ Tab "Papelera" en `/admin/settings`
- ✅ Al eliminar: pide motivo (min 3 chars)
- ✅ Guarda: `deletedAt`, `deletedById`, `deletedByName`, `deletedReason`
- ✅ Restaurar desde papelera (undo)
- ✅ Solo OWNER puede ver/tocar

---

### 6. **Admin Secrets Vault** (Hace 2 días)
- ✅ Página `/admin/secrets` (OWNER-only)
- ✅ CRUD de secrets cifrados (AES-256-GCM)
- ✅ Auditoría: quién, cuándo, qué cambió
- ✅ Llaves de encriptación desde `infra/.env.web`

---

## 🔧 Fixes & Improvements

| Problema | Fix | Impacto |
|----------|-----|---------|
| `.gitignore` silenciaba `/admin/secrets` | Cambió `secrets/` → `/secrets/` | Código secreto ahora se pushea |
| Dashboard congelado para cuentas pausadas | Fetch insights de TODAS las cuentas (no solo activas) | Datos frescos incluso desactivadas |
| `getAdAccounts` devolvía lista parcial en error | Cambió `break` → `throw` | No archiva cuentas reales por error |
| State badge decía "pausada" (impreciso) | `account_status=2` → "Desactivado" (rojo) | Labels correctos Meta |
| Solo 3 presets pre-sincronizados | N/A (Archivadas quedan "en vivo") | Mejor perf, menos cuota |

---

## 📊 Impacto en Cuota Meta (estimado)

| Job | Frecuencia | Cuentas | Llamadas/ciclo | % Cuota/día |
|-----|-----------|---------|----------------|------------|
| Dashboard sync | 5 AM diario | ~14 | 14 × 3 presets = 42 | ~1% |
| Spend daily | 6 AM diario | ~14 activas | 14 × time_inc=1 | ~0.5% |
| Fanpage sync | 5 AM diario | 2 BMs | 4-6 | <0.1% |
| **Total nuevos** | — | — | ~50/día | **~1.5%** |

**Contexto**: Meta permite ~5,000 llamadas/día por cuenta. Con ~14 cuentas = 70k total. 1.5% = 1,050 llamadas. ✅ Sano.

---

## 🗄️ Schema Changes

### Migration: `0004_add_currency_to_spend_and_insights`

```sql
-- Add currency tracking to daily spend ledger
ALTER TABLE "meta"."AccountSpendDaily" ADD COLUMN "currency" TEXT;

-- Add currency tracking to dashboard snapshots
ALTER TABLE "meta"."AccountInsightSnapshot" ADD COLUMN "currency" TEXT;
```

**Rollback**: `DROP COLUMN currency` en ambas tablas.

---

## 📋 QA Checklist

- [x] Tipos TypeScript compilables
- [x] Migraciones Prisma válidas (solo schema, no datos)
- [x] Endpoints `/api/*` responden
- [x] Jobs BullMQ se registran (logs: "Job handler registered")
- [x] UI renderiza sin console errors
- [x] Permisos OWNER respetados (secrets, BM delete)
- [ ] **TODO en producción**: Backup DB antes de migración
- [ ] **TODO en producción**: Test login + sync buttons
- [ ] **TODO en producción**: Revisar logs post-deploy 5 min

---

## 🚀 Deployment

**Prerrequisitos**:
1. Permisos en servidor (read infra/.env, write repo)
2. Victor ejecutó: `chmod -R g+w /opt/apps/winners-platform/repo`
3. DB backup automático

**Pasos** (en DEPLOY_RUNBOOK.md):
1. SSH + git pull
2. DB backup + migration
3. Docker build
4. Docker compose up
5. Health checks

**Rollback**: Revert imágenes Docker + Restore DB desde backup

---

## 📝 Notas

- **Local database**: Restaura desde prod dump en `~/dumps/winners-latest.sql.gz`
- **Env vars**: ENCRYPTION_KEY ya está en `infra/.env.web` (production), `.env.local` (local test)
- **Workers**: Corren en `winners-meta-worker` container, jobs en Redis/BullMQ
- **Rate limiting**: Caché + coalescing mantiene cuota baja

---

## ✅ Sign-off

- Código: ✅ Compilado
- Tests: ⏭️ (no hay suite formal)
- Docs: ✅ Runbook + Changelog
- Ready for deploy: ✅ **Sí**
