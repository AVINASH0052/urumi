// Upstream MCP servers: CRUD-level data access, one-shot MCP connections, and the health poller.
// Connect-per-operation on purpose (PLAN.md §5.2): no pooled sessions to go stale when an
// upstream pod restarts, nothing to keep consistent across gateway replicas.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { pool, q } from './db.ts';
import { decrypt } from './crypto.ts';
import { assertSafeUrl } from './ssrf.ts';
import { config } from './config.ts';

export type ServerRow = {
  id: string; slug: string; name: string; url: string;
  auth_type: 'none' | 'bearer' | 'header'; auth_header_name: string | null; credential_enc: string | null;
  enabled: boolean; timeout_ms: number; status: 'unknown' | 'connected' | 'unreachable';
  last_error: string | null; last_checked_at: string | null; tools: CachedTool[];
};
// `exposed` is the name clients see (<slug>__<tool>, ≤64 chars); `tool` is the upstream original.
export type CachedTool = Tool & { exposed: string };

export const getServer = async (slug: string) => (await q<ServerRow>('SELECT * FROM servers WHERE slug = $1', [slug]))[0];

// Tool names must fit ^[a-zA-Z0-9_-]{1,64}$ for LLM APIs. Long ones get truncated + a stable hash.
export function exposedName(slug: string, tool: string) {
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `${slug}__${clean}`;
  if (full.length <= 64) return full;
  const h = createHash('sha256').update(tool).digest('hex').slice(0, 6);
  return `${full.slice(0, 57)}_${h}`;
}

export class UpstreamError extends Error {
  outcome: 'timeout' | 'unreachable';
  constructor(outcome: 'timeout' | 'unreachable', message: string) { super(message); this.outcome = outcome; }
}

function describe(e: unknown): string {
  const err = e as any;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return [err?.message ?? String(e), cause].filter(Boolean).join(': ');
}

// Open a session, run fn, always close. The whole thing (connect + op) shares one deadline.
export async function withUpstream<T>(s: ServerRow, timeoutMs: number, fn: (c: Client, opts: { timeout: number; signal: AbortSignal }) => Promise<T>): Promise<T> {
  await assertSafeUrl(s.url).catch((e) => { throw new UpstreamError('unreachable', `blocked by SSRF policy: ${e.message}`); });
  const headers: Record<string, string> = {};
  if (s.credential_enc && s.auth_type === 'bearer') headers.Authorization = `Bearer ${decrypt(s.credential_enc)}`;
  if (s.credential_enc && s.auth_type === 'header' && s.auth_header_name) headers[s.auth_header_name] = decrypt(s.credential_enc);

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const client = new Client({ name: 'urumi-gateway', version: '0.1.0' });
  // redirect:'error' so an upstream can't bounce us to an internal address after the SSRF check.
  const transport = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers, redirect: 'error', signal: ac.signal } });
  try {
    // Our AbortController is the deadline; the SDK's own timer is only a backstop behind it.
    const opts = { timeout: timeoutMs + 1000, signal: ac.signal };
    await client.connect(transport, opts);
    return await fn(client, opts);
  } catch (e) {
    if (ac.signal.aborted || Date.now() - started >= timeoutMs) throw new UpstreamError('timeout', `upstream '${s.slug}' timed out after ${timeoutMs}ms`);
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError('unreachable', `upstream '${s.slug}' unreachable: ${describe(e)}`);
  } finally {
    clearTimeout(timer);
    // close() alone doesn't end the session server-side; stateful upstreams would keep every
    // one of our short-lived sessions in memory. DELETE it (a 405 from stateless servers is fine).
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export async function fetchTools(s: ServerRow): Promise<CachedTool[]> {
  return withUpstream(s, Math.min(s.timeout_ms, 5000), async (c, opts) => {
    const out: CachedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.listTools(cursor ? { cursor } : undefined, opts);
      for (const t of page.tools) out.push({ ...t, exposed: exposedName(s.slug, t.name) });
      cursor = page.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  });
}

// Refresh one server's cached tools + status. Never throws.
export async function refresh(s: ServerRow) {
  if (!s.enabled) return;
  try {
    const tools = await fetchTools(s);
    await q(`UPDATE servers SET tools = $2, status = 'connected', last_error = NULL, last_checked_at = now() WHERE id = $1`, [s.id, JSON.stringify(tools)]);
  } catch (e) {
    await markUnreachable(s.id, (e as Error).message);
  }
}

export const markUnreachable = (id: string, error: string) =>
  q(`UPDATE servers SET status = 'unreachable', last_error = $2, last_checked_at = now() WHERE id = $1`, [id, error.slice(0, 500)]);

// One replica polls: whoever holds the advisory lock. If that pod dies, its connection closes,
// the lock is released, and another replica takes over on its next attempt.
export function startPoller() {
  let leader: import('pg').PoolClient | null = null;
  let running = false;
  const drop = () => { leader?.release(true); leader = null; };
  const tick = async () => {
    if (running) return;            // a slow round must not overlap the next one
    running = true;
    try {
      if (leader) await leader.query('SELECT 1');   // still holding the lock? (throws if the connection died)
      else {
        const c = await pool.connect();
        c.on('error', drop);        // connection lost (e.g. Postgres restart): give up leadership, don't crash
        if ((await c.query('SELECT pg_try_advisory_lock(4202) AS ok')).rows[0].ok) leader = c;
        else return c.release();
      }
      const servers = await q<ServerRow>('SELECT * FROM servers WHERE enabled');
      await Promise.allSettled(servers.map(refresh));
    } catch (e) {
      console.error(JSON.stringify({ msg: 'poller error', error: String(e) }));
      drop();
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, config.pollMs);
  // On shutdown, hand leadership over immediately: destroying the connection drops the lock,
  // so another replica starts polling on its next tick instead of after our grace period.
  return () => { clearInterval(timer); drop(); };
}
