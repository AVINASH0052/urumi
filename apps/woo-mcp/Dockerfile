# Build context: repo root (npm workspaces share one lockfile).
FROM node:22.22.3-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
RUN npm ci --omit=dev -w apps/woo-mcp --ignore-scripts

# No build step: Node 22 runs the TypeScript source directly (type stripping).
FROM node:22.22.3-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/woo-mcp/src apps/woo-mcp/src
USER node
EXPOSE 3000
CMD ["node", "apps/woo-mcp/src/index.ts"]
