# Build context: repo root (npm workspaces share one lockfile).
FROM node:22.22.3-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/utils-mcp/package.json apps/utils-mcp/
RUN npm ci --omit=dev -w apps/utils-mcp --ignore-scripts

# No build step: Node 22 runs the TypeScript source directly (type stripping).
FROM node:22.22.3-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY apps/utils-mcp/package.json apps/utils-mcp/
COPY apps/utils-mcp/src apps/utils-mcp/src
USER node
EXPOSE 3000
CMD ["node", "apps/utils-mcp/src/index.ts"]
