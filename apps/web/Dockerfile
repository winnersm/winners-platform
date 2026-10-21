# Imagen de la app única. Se construye desde la RAÍZ del monorepo:
#   docker build -f apps/web/Dockerfile .
#
# Multi-stage para que la imagen final no arrastre ni el código fuente ni las
# dependencias de compilación.

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /repo

# ─── Dependencias ────────────────────────────────────────────────────────────
# Se copian solo los manifests antes que el código: así una edición de código
# no invalida la caché de la instalación, que es lo que más tarda.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/

# pnpm 11 bloquea los scripts de instalación y sale con error si encuentra
# alguno sin autorizar — ni `onlyBuiltDependencies` en pnpm-workspace.yaml ni
# `only-built-dependencies[]` en .npmrc evitan ese error (11.9.0).
#
# Así que se instala sin scripts (salida limpia) y luego se reconstruyen a mano
# solo los paquetes que de verdad los necesitan: los motores de Prisma y los
# binarios nativos que usan Next y su bundler.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild esbuild sharp unrs-resolver msgpackr-extract @prisma/engines prisma

# ─── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY . .

# El cliente de Prisma se genera desde el esquema, no viene en el repo.
# La URL es ficticia a propósito: generate no se conecta a nada.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    pnpm --filter @winners/db exec prisma generate

# Next necesita estas variables presentes al construir; los valores reales
# llegan en tiempo de ejecución desde el .env del servidor.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    AUTH_SECRET="build-time-placeholder" \
    SKIP_ENV_VALIDATION=1 \
    pnpm --filter @winners/web build

# El worker de duplicaciones se empaqueta en un solo fichero. Así se resuelven
# los alias @/ y no depende de cómo pnpm coloque los enlaces de node_modules,
# que es donde fallaba al compilarlo solo con tsc.
RUN pnpm --filter @winners/web run build:worker

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuario sin privilegios: si alguien logra ejecutar algo dentro del
# contenedor, no lo hace como root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# La salida standalone trae solo lo que la app necesita para arrancar,
# incluidas las dependencias de los paquetes del workspace.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]

# ─── Worker ──────────────────────────────────────────────────────────────────
# Misma base, distinto proceso. Se despliega como servicio aparte para que un
# despliegue de la web no corte una duplicación a medias.
FROM node:22-alpine AS worker
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs-user -u 1001

COPY --from=builder --chown=nodejs-user:nodejs /repo/apps/web/dist/worker.js ./worker.js
# Solo lo que quedó fuera del bundle: los paquetes con binarios o que no se
# empaquetan bien (Prisma y el SDK de Meta).
COPY --from=builder --chown=nodejs-user:nodejs /repo/apps/web/node_modules ./node_modules

USER nodejs-user

CMD ["node", "worker.js"]
