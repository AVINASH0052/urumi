// Second upstream: small utilities. Requires a bearer token, which exercises the gateway's
// per-server credential handling. `echo` deliberately collides with the reference
// "everything" server, and `sleep` makes gateway timeouts easy to demo.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const TOKEN = Buffer.from(`Bearer ${process.env.MCP_TOKEN ?? ''}`);
if (!process.env.MCP_TOKEN) throw new Error('MCP_TOKEN is required');
const PORT = Number(process.env.PORT ?? 3000);

// Static demo rates (per 1 USD) so the server has no external dependency.
const RATES: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.2, JPY: 149.5, AUD: 1.52, CAD: 1.36 };

// Tiny arithmetic parser: numbers, + - * / and parentheses. No eval.
function calculate(expr: string): number {
  const s = expr.replace(/\s+/g, '');
  let i = 0;
  const num = (): number => {
    if (s[i] === '(') { i++; const v = add(); if (s[i++] !== ')') throw new Error('missing )'); return v; }
    if (s[i] === '-') { i++; return -num(); }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected '${s[i] ?? 'end'}' at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const mul = (): number => { let v = num(); while (s[i] === '*' || s[i] === '/') v = s[i++] === '*' ? v * num() : v / num(); return v; };
  const add = (): number => { let v = mul(); while (s[i] === '+' || s[i] === '-') v = s[i++] === '+' ? v + mul() : v - mul(); return v; };
  const v = add();
  if (i !== s.length) throw new Error(`unexpected '${s[i]}' at ${i}`);
  return v;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const error = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

function buildServer() {
  const server = new McpServer({ name: 'utils-mcp', version: '0.1.0' });
  server.registerTool('convert_currency', {
    description: `Convert an amount between currencies using fixed demo rates. Supported: ${Object.keys(RATES).join(', ')}.`,
    inputSchema: { amount: z.number(), from: z.string().length(3), to: z.string().length(3) },
    annotations: { readOnlyHint: true },
  }, async ({ amount, from, to }) => {
    const f = RATES[from.toUpperCase()], t = RATES[to.toUpperCase()];
    if (!f || !t) return error(`unsupported currency; use one of ${Object.keys(RATES).join(', ')}`);
    return text({ amount, from: from.toUpperCase(), to: to.toUpperCase(), result: Math.round((amount / f) * t * 100) / 100 });
  });
  server.registerTool('now', {
    description: 'Current date and time, optionally in an IANA timezone such as Asia/Kolkata.',
    inputSchema: { timezone: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ timezone }) => {
    try { return text({ iso: new Date().toISOString(), local: new Date().toLocaleString('en-GB', { timeZone: timezone ?? 'UTC' }), timezone: timezone ?? 'UTC' }); }
    catch (e) { return error(e); }
  });
  server.registerTool('calculate', {
    description: 'Evaluate an arithmetic expression with + - * / and parentheses.',
    inputSchema: { expression: z.string().max(200) },
    annotations: { readOnlyHint: true },
  }, async ({ expression }) => { try { return text({ expression, result: calculate(expression) }); } catch (e) { return error(e); } });
  server.registerTool('echo', {
    description: 'Echo a message back (same tool name as the reference "everything" server, on purpose).',
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ message }) => text(`utils echo: ${message}`));
  server.registerTool('sleep', {
    description: 'Wait N seconds, then return. Useful to demonstrate gateway timeouts.',
    inputSchema: { seconds: z.number().min(0).max(120) },
    annotations: { readOnlyHint: true },
  }, async ({ seconds }) => { await new Promise((r) => setTimeout(r, seconds * 1000)); return text(`slept ${seconds}s`); });
  return server;
}

const authorized = (h?: string) => { const b = Buffer.from(h ?? ''); return b.length === TOKEN.length && timingSafeEqual(b, TOKEN); };

const httpServer = http.createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if (path === '/healthz') return void res.writeHead(200).end('ok');
  if (path !== '/mcp') return void res.writeHead(404).end();
  if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
  if (!authorized(req.headers.authorization)) return void res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return void res.writeHead(400).end('invalid JSON'); }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});
httpServer.listen(PORT, () => console.log(JSON.stringify({ msg: `utils-mcp listening on :${PORT}` })));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
