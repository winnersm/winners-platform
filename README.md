# Winners Platform

Una sola aplicación, una URL, un login, roles por módulo.

Consolida cinco aplicaciones que hoy viven separadas en el servidor Hetzner:

| Módulo | Ruta | Viene de |
|---|---|---|
| Meta Ads | `/meta` | `newappmeta` (`ads.mastermindwinners.com`) |
| Automations | `/automations` | `automations-hub` (`automations.mastermindwinners.com`) |
| Links | `/links` | `acortador` (`links.mastermindwinners.com`) |
| Monitor | `/monitor` | `link-monitor` (`ffmonitorlinks.mastermindwinners.com`) |
| Clonador | `/cloner` | `opwinners` (app local, sin desplegar) |
| Admin | `/admin` | nuevo — usuarios, roles, secretos, auditoría |

`dash` (Meta Automation) se mantiene aparte por ahora. Al final se le conecta el
login de esta app para que haya una sola contraseña.

El plan completo está en `../hetznerWinners/PLAN-CONSOLIDACION.md`.

## Estructura

```
apps/
  web/          la app única (Next.js 16)
  redirector/   servicio público mínimo: slug → 302, aislado a propósito
services/
  automations-worker/   Python — billing, autopause, Google Sheets
  monitor-engine/       Python + Playwright — chequeo de tracking links
  cloner-engine/        Python + ffmpeg — clonado de campañas entre cuentas
packages/
  db/           esquema Prisma (6 schemas) + cliente
  ui/           design system compartido (shadcn/ui + Tailwind 4)
  auth/         Auth.js + control de permisos
  config/       tsconfig, eslint, preset de Tailwind
infra/          docker-compose y scripts de despliegue
```

## Por qué los servicios Python están fuera de `apps/`

No son aplicaciones: son procesos de fondo sin interfaz ni login. Corren solos
aunque nadie tenga el navegador abierto, y deben seguir corriendo mientras se
despliega la web. Su interfaz de usuario vive dentro de la app única; aquí solo
queda el motor.

Se conservan en Python porque están probados contra gasto publicitario real.
Reescribirlos sería semanas de trabajo y de errores sutiles, sin que el usuario
note diferencia alguna.

## Por qué el redirector está separado

`linknowhub.com`, `globalnodehub.com` y `elevationgateway.com` reciben tráfico
pagado. Si el redirector viviera dentro del monolito, cada despliegue de la web
cortaría clics durante unos segundos. Aislado, solo cambia cuando cambia él.

## Base de datos

Un solo Postgres, un schema por dominio:

| Schema | Contenido |
|---|---|
| `core` | usuarios, operaciones, permisos, auditoría, secretos |
| `meta` | Business Managers, cuentas, fanpages, lanzamientos, snapshots |
| `links` | dominios, enlaces cortos, URLs de FunnelFlux |
| `automations` | tareas programadas, ejecuciones, alertas de billing |
| `monitor` | tracking links, chequeos, incidentes |

`reports` queda reservado por si algún día se absorbe `dash`.

Schemas separados dan aislamiento y migraciones independientes, pero permiten
hacer JOIN entre módulos — que es justo lo que hoy no se puede, porque cada app
tiene su propia base.

## Puesta en marcha

```bash
pnpm install
pnpm db:generate
pnpm dev
```

Hace falta un `.env` con `DATABASE_URL`. En el servidor, la base vive en
`/opt/apps/winners-platform/` (contenedores `winners-pg` y `winners-redis`),
publicada solo en `127.0.0.1:5435` — se llega por túnel SSH, nunca desde fuera.

## Backups

Diarios a las 3:30 (hora del servidor) vía `/opt/backups/backup.sh`, con prueba
de restauración automática los domingos. Los scripts están versionados en
`../hetznerWinners/server/backup/`.
