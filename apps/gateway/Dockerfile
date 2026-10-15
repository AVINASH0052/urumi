# Build context: repo root (npm workspaces share one lockfile).

# 1) Dashboard: static React build, served by the gateway (same origin, no CORS, no extra pod).
FROM node:22.22.3-alpine AS ui
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci -w apps/dashboard
COPY apps/dashboard apps/dashboard
RUN npm run build -w apps/dashboard

# 2) Gateway runtime deps only.
FROM node:22.22.3-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --omit=dev -w apps/gateway --ignore-scripts

# 3) Runtime. No build step for the gateway: Node 22 runs the TypeScript directly.
FROM node:22.22.3-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY apps/gateway/package.json apps/gateway/
COPY apps/gateway/migrations apps/gateway/migrations
COPY apps/gateway/src apps/gateway/src
COPY --from=ui /app/apps/dashboard/dist apps/gateway/public
USER node
EXPOSE 3000
CMD ["node", "apps/gateway/src/index.ts"]
