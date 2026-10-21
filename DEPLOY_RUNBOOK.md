# 🚀 Deployment Runbook — Producción (Hetzner CPX42)

**Última actualización**: 2026-10-21  
**Rama**: `integration/all-features`  
**Cambios**: Currency fix + BM trash + spend history + fanpage sync + dashboard sync

---

## Pre-Deploy Checklist

- [ ] **Permisos confirmados** con Victor:
  - `chmod -R g+w /opt/apps/winners-platform/repo`
  - `chmod g+r /opt/apps/winners-platform/infra/.env.web`
  - Sudo sin contraseña: `/usr/bin/docker compose *` y `/bin/systemctl restart winners*`

- [ ] **Rama actualizada localmente**:
  ```bash
  git fetch origin
  git checkout integration/all-features
  git pull origin integration/all-features
  ```

- [ ] **Tests pasando** (si existen):
  ```bash
  pnpm test
  ```

- [ ] **Build local sin errores**:
  ```bash
  pnpm build
  ```

---

## Pasos de Deploy

### 1. SSH al servidor y navega al repo
```bash
ssh duglas@157.90.162.153
cd /opt/apps/winners-platform/repo
git fetch origin
git checkout integration/all-features
git pull origin
```

### 2. Backup de la DB (CRÍTICO)
```bash
# Dump completo (toma ~5 min)
pg_dump \
  -h 127.0.0.1 -p 5435 \
  -U winners \
  --compress \
  -f /opt/backups/winners-$(date +%Y%m%d-%H%M%S).sql.gz \
  winners

echo "Backup saved. Verify:"
ls -lh /opt/backups/winners-*.sql.gz | tail -1
```

### 3. Aplicar migración de DB (ALTER TABLE)
```bash
cd /opt/apps/winners-platform/repo/packages/db
DATABASE_URL="postgresql://winners:$DB_PASSWORD@127.0.0.1:5435/winners?schema=public" \
  pnpm prisma migrate deploy
```

**Si falla**:
- Revisa el estado: `pnpm prisma migrate status`
- Rollback manual (ver sección **Rollback**)

### 4. Rebuild de imágenes Docker

**Tag de respaldo** (para rollback rápido):
```bash
sudo docker tag winners-web:latest winners-web:pre-$(date +%Y%m%d-%H%M%S)
sudo docker tag winners-meta-worker:latest winners-meta-worker:pre-$(date +%Y%m%d-%H%M%S)
```

**Rebuild**:
```bash
cd /opt/apps/winners-platform/repo
sudo docker compose build --no-cache winners-web winners-meta-worker
```

**Verificar imágenes**:
```bash
sudo docker image ls | grep winners
```

### 5. Redeploy (zero-downtime con Traefik)
```bash
cd /opt/apps/winners-platform/repo
sudo docker compose up -d winners-web winners-meta-worker

# Esperar a que levanten (logs en tiempo real)
sudo docker compose logs -f --tail=50 winners-web winners-meta-worker
```

**Señales de éxito en logs**:
- `winners-web`: "ready — started server on 0.0.0.0:3000"
- `winners-meta-worker`: "Worker started" o "Job handler registered"

### 6. Health check post-deploy

```bash
# 1. API request (a través de Traefik)
curl -s https://app.mastermindwinners.com/api/health | jq .

# 2. Worker job (chequear que está escuchando)
sudo docker exec winners-meta-worker \
  pnpm exec bull-board-cli list-queues

# 3. Logs de los últimos 2 minutos
sudo docker compose logs --since 2m winners-web winners-meta-worker | tail -30
```

### 7. Validación en app

1. **Navega a https://app.mastermindwinners.com**
2. **Login y abre `/meta/spend`**:
   - ¿Ves totales SEPARADOS por moneda (USD, COP)?
   - ¿Las cuentas muestran su moneda en paréntesis?
3. **Abre `/meta/dashboard`**:
   - ¿Totales agrupados por moneda?
   - ¿Las cuentas muestran `(USD)` / `(COP)` en la tabla?
4. **Sincronización**:
   - Botón "Sincronizar con Meta" en ambas vistas → debe traer datos frescos
   - Workers corriendo: `sudo docker compose ps | grep winner`

---

## Si algo falla: Rollback

### Rollback DB (revertir migración)
```bash
cd /opt/apps/winners-platform/repo/packages/db
DATABASE_URL="postgresql://winners:$DB_PASSWORD@127.0.0.1:5435/winners?schema=public" \
  pnpm prisma migrate resolve --rolled-back 0004_add_currency_to_spend_and_insights

# Restaurar desde backup si es necesario
pg_restore \
  -h 127.0.0.1 -p 5435 \
  -U winners \
  -d winners \
  /opt/backups/winners-YYYYmmdd-HHMMSS.sql.gz
```

### Rollback Docker (volver a imágenes anteriores)
```bash
sudo docker tag winners-web:pre-YYYYmmdd-HHMMSS winners-web:latest
sudo docker tag winners-meta-worker:pre-YYYYmmdd-HHMMSS winners-meta-worker:latest
sudo docker compose up -d winners-web winners-meta-worker
sudo docker compose logs -f --tail=50 winners-web winners-meta-worker
```

### Reset completo (última opción)
```bash
# NO ejecutar sin confirmación — esto borra datos
sudo docker compose down -v
pg_restore ... # restore DB
sudo docker compose up -d
```

---

## Checklist post-deploy

- [ ] App accesible en https://app.mastermindwinners.com
- [ ] Login funciona
- [ ] `/meta/spend` muestra totales por moneda
- [ ] `/meta/dashboard` muestra totales por moneda
- [ ] Botones de sincronización responden
- [ ] Logs sin errores en los últimos 5 min
- [ ] DB_PASSWORD está asignada en env
- [ ] Backups están archivados

---

## Rollout plan (si hay issues post-deploy)

| Escenario | Acción | Tiempo |
|-----------|--------|--------|
| App lenta | Chequea logs, revisa CPU/RAM (`docker stats`) | 5 min |
| Totales no aparecen | Schema no aplicó: revisa `prisma migrate status` | 10 min |
| Workers no arrancan | Revisa env vars: `docker compose config \| grep ENCRYPTION` | 5 min |
| Datos corruptos | Rollback DB desde backup | 15 min |

---

## Comandos útiles en producción

```bash
# Ver estado de servicios
sudo docker compose ps

# Ver logs en tiempo real
sudo docker compose logs -f winners-web winners-meta-worker

# Restart sin rebuild
sudo docker compose restart winners-web winners-meta-worker

# Exec comando en container
sudo docker exec winners-web pnpm exec node -e "console.log(process.env.NODE_ENV)"

# Estadísticas de recursos
sudo docker stats winners-web winners-meta-worker

# Entrar a la shell del container
sudo docker exec -it winners-web /bin/sh
```

---

## Notas de arquitectura

- **PostgreSQL**: `127.0.0.1:5435` (solo acceso local)
- **Redis**: `127.0.0.1:6379` (caché, jobs)
- **Traefik**: v3.5 (reverse proxy, HTTPS, rate limit)
- **Docker Network**: `proxy` (public-facing), `winners-net` (internal)

---

**¿Preguntas?** Revisa logs, backups, o reubicar al plan de rollback.
