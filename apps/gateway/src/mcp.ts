// The single MCP endpoint. Stateless Streamable HTTP: a fresh Server per request, the
// authenticated user captured in closure. Any replica can serve any request.
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, listTools, type User } from './core.ts';

export async function mcpHandler(req: Request, res: Response) {
  const user: User = res.locals.user;
  const apiKeyId: string = res.locals.apiKeyId;
  // Low-level Server: we forward upstream JSON Schemas verbatim instead of declaring zod ones.
  const server = new Server({ name: 'urumi-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(user) }));
  server.setRequestHandler(CallToolRequestSchema, async (r) =>
    callTool(user, r.params.name, r.params.arguments ?? {}, { source: 'mcp', apiKeyId }));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// MCP Inspector in direct browser mode needs CORS. Safe: /mcp auth is a header, never a cookie.
export function mcpCors(req: Request, res: Response, next: () => void) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
  });
  if (req.method === 'OPTIONS') return void res.status(204).end();
  next();
}
