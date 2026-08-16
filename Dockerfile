# syntax=docker/dockerfile:1
# defect-drainer-backend — Fastify harness API (inventory, batch jobs, search).

ARG NODE_VERSION=22
ARG PNPM_VERSION=11.1.3

FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
# pnpm 11 may ignore dependency build scripts unless allow-all is set
RUN --mount=type=cache,id=pnpm-dd-backend,target=/pnpm/store \
	pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-dd-backend,target=/pnpm/store \
	pnpm install --prod --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8788
# Inventory (evidence/) + runtime (sqlite, batch-jobs) — override via compose mounts
ENV DEFECTS_ROOT=/data/inventory
ENV DEFECT_DRAINER_DATA=/data/runtime
WORKDIR /app

# Root user keeps host bind-mounts writable for local/dev (inventory + runtime).
# Tighten with a non-root user + entrypoint chown when hardening prod.
RUN mkdir -p /data/inventory/evidence /data/runtime

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 8788

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
