# Imagen del redirector. Se construye desde la RAÍZ del monorepo:
#   docker build -f apps/redirector/Dockerfile .
#
# Servicio aislado a propósito: los dominios de tracking reciben tráfico
# pagado y no pueden caerse cada vez que se despliega el panel.

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /repo

# ─── Dependencias ────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Hacen falta TODOS los manifests del workspace: --frozen-lockfile compara el
# lockfile con el conjunto completo, no solo con lo que este servicio usa.
COPY apps/web/package.json apps/web/
COPY apps/redirector/package.json apps/redirector/
COPY packages/db/package.json packages/db/
COPY packages/auth/package.json packages/auth/

# pnpm 11 sale con error si encuentra scripts de instalación sin autorizar, y
# ni pnpm-workspace.yaml ni .npmrc lo evitan (11.9.0). Se instala sin scripts y
# se reconstruye a mano lo que de verdad los necesita.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild esbuild sharp unrs-resolver msgpackr-extract @prisma/engines prisma

# ─── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/redirector/node_modules ./apps/redirector/node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY . .

RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    pnpm --filter @winners/db exec prisma generate

RUN pnpm --filter @winners/redirector build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat wget
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /repo/apps/redirector/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/redirector/.next/static ./apps/redirector/.next/static

USER nextjs
EXPOSE 3000

# El healthcheck consulta la base: un redirector que responde pero no puede
# leer enlaces está caído, aunque el proceso siga vivo.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "apps/redirector/server.js"]
