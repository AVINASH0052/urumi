# Third upstream: the official MCP reference server, pinned, over Streamable HTTP on :3001.
FROM node:22.22.3-alpine
RUN npm install -g --ignore-scripts @modelcontextprotocol/server-everything@2026.8.31 && npm cache clean --force
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["mcp-server-everything", "streamableHttp"]
