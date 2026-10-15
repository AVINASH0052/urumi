// WooCommerce MCP server: exposes one store's products and orders as MCP tools over
// Streamable HTTP. Stateless (fresh server per request), so restarts and replicas are free.
// Talks to the store through the WooCommerce REST API v3 (see PLAN.md §4.1 for why).
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const WC_URL = env('WC_URL'); // in-cluster Service, e.g. http://urumi-wordpress
const WC_AUTH = 'Basic ' + Buffer.from(`${env('WC_CONSUMER_KEY')}:${env('WC_CONSUMER_SECRET')}`).toString('base64');
const TOKEN = Buffer.from(`Bearer ${env('MCP_TOKEN')}`);
const PORT = Number(process.env.PORT ?? 3000);
// Public storefront origin. WP builds links from the request scheme, and our requests claim
// HTTPS (see wc()), so links are rewritten to what shoppers actually use.
const PUBLIC_URL = process.env.STORE_PUBLIC_URL?.replace(/\/$/, '');
const publicLink = (u: string) => (PUBLIC_URL && u ? u.replace(/^https?:\/\/[^/]+/, PUBLIC_URL) : u);

// ---------- WooCommerce client ----------

type Query = Record<string, string | number | boolean | undefined>;

async function wc(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<any> {
  const url = new URL(`/wp-json/wc/v3${path}`, WC_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: WC_AUTH,
      // WC only accepts key/secret Basic auth when is_ssl(); WordPress maps this header to HTTPS.
      // NetworkPolicy makes woo-mcp (and Traefik, which overwrites it) the only possible sender.
      'X-Forwarded-Proto': 'https',
      'Content-Type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`WooCommerce ${res.status}: ${data?.message ?? res.statusText}`);
  return data;
}

// Trim WC's very large payloads to what a model actually needs.
const product = (p: any) => ({
  id: p.id, name: p.name, price: p.price, regular_price: p.regular_price,
  status: p.status, stock_status: p.stock_status, permalink: publicLink(p.permalink),
});
const order = (o: any) => ({
  id: o.id, status: o.status, total: o.total, currency: o.currency,
  date_created_gmt: o.date_created_gmt, payment_method: o.payment_method_title,
  customer: `${o.billing?.first_name ?? ''} ${o.billing?.last_name ?? ''}`.trim(), email: o.billing?.email,
  items: (o.line_items ?? []).map((i: any) => ({ name: i.name, quantity: i.quantity, total: i.total })),
});

function startOfUtcDay(daysAgo = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 19);
}

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;
const page = { page: z.number().int().min(1).default(1), per_page: z.number().int().min(1).max(100).default(20) };

// ---------- MCP server ----------

function buildServer(requestId: string) {
  const server = new McpServer({ name: 'woo-mcp', version: '0.1.0' });

  // Every tool: log one line, turn exceptions into a readable isError result.
  const tool = <S extends z.ZodRawShape>(
    name: string, description: string, inputSchema: S, readOnly: boolean,
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, (async (args: any) => {
    const t0 = Date.now();
    try {
      const data = await fn(args);
      log({ requestId, tool: name, ok: true, ms: Date.now() - t0 });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] } satisfies CallToolResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log({ requestId, tool: name, ok: false, ms: Date.now() - t0, error: msg });
      return { isError: true, content: [{ type: 'text', text: msg }] } satisfies CallToolResult;
    }
  }) as any);

  tool('list_products', 'List or search products in the store.', {
    search: z.string().optional().describe('Text to match in product name or description'),
    status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).default('any'),
    ...page,
  }, true, async (a) => (await wc('GET', '/products', { query: a })).map(product));

  tool('create_product', 'Create a simple product. It is published to the storefront by default.', {
    name: z.string().min(1),
    regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/).describe('Decimal price as a string, e.g. "12.50"'),
    description: z.string().optional(),
    status: z.enum(['publish', 'draft']).default('publish'),
  }, false, async (a) => product(await wc('POST', '/products', { body: { type: 'simple', ...a } })));

  tool('list_orders', 'List orders, newest first. Use period="today" for orders placed today (UTC).', {
    period: z.enum(['today', 'last_7_days']).optional(),
    after: z.string().optional().describe('ISO 8601 UTC date-time, inclusive lower bound'),
    before: z.string().optional().describe('ISO 8601 UTC date-time, exclusive upper bound'),
    status: z.enum(ORDER_STATUSES).optional(),
    ...page,
  }, true, async ({ period, ...a }) => {
    const after = period === 'today' ? startOfUtcDay() : period === 'last_7_days' ? startOfUtcDay(7) : a.after;
    return (await wc('GET', '/orders', { query: { ...a, after, dates_are_gmt: true } })).map(order);
  });

  tool('get_order', 'Get one order by ID.', { id: z.number().int().positive() },
    true, async ({ id }) => order(await wc('GET', `/orders/${id}`)));

  tool('update_order_status', 'Change the status of an order.', {
    id: z.number().int().positive(),
    status: z.enum(ORDER_STATUSES),
  }, false, async ({ id, status }) => order(await wc('PUT', `/orders/${id}`, { body: { status } })));

  return server;
}

// ---------- HTTP ----------

const log = (o: object) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

function authorized(header: string | undefined) {
  const got = Buffer.from(header ?? '');
  return got.length === TOKEN.length && timingSafeEqual(got, TOKEN);
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const httpServer = http.createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if (path === '/healthz') return void res.writeHead(200).end('ok');
  if (path !== '/mcp') return void res.writeHead(404).end();
  if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end(); // stateless: no GET stream
  if (!authorized(req.headers.authorization)) return void res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();

  let body: unknown;
  try { body = await readJson(req); } catch { return void res.writeHead(400).end('invalid JSON'); }

  const requestId = String(req.headers['x-request-id'] ?? crypto.randomUUID());
  const server = buildServer(requestId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log({ requestId, error: String(e) });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, () => log({ msg: `woo-mcp listening on :${PORT}`, store: WC_URL }));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
