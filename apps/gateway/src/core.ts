// The gateway core. Both the /mcp endpoint and the chat agent go through these two functions,
// so permissions, routing, timeouts and auditing behave the same for every caller.
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { q } from './db.ts';
import { getServer, markUnreachable, UpstreamError, withUpstream, type ServerRow } from './upstream.ts';

export type User = { id: string; email: string; role: 'admin' | 'member' };
export type CallCtx = { source: 'mcp' | 'chat'; apiKeyId?: string };
type Outcome = 'ok' | 'error' | 'timeout' | 'unreachable' | 'denied';

const SEP = '__';
const MAX_DESC = 1024;

// Served from the cache the poller maintains: a slow or dead upstream can't slow down listing.
export async function listTools(_user: User): Promise<Tool[]> {
  const servers = await q<ServerRow>(`SELECT slug, name, tools FROM servers WHERE enabled AND status = 'connected' ORDER BY slug`);
  return servers.flatMap((s) => s.tools.map(({ exposed, name: _orig, ...t }) => ({
    ...t,
    name: exposed,
    description: `[${s.name}] ${t.description ?? ''}`.slice(0, MAX_DESC),
  })));
}

export async function callTool(user: User, name: string, args: Record<string, unknown>, ctx: CallCtx): Promise<CallToolResult> {
  const t0 = Date.now();
  const i = name.indexOf(SEP);
  const slug = i > 0 ? name.slice(0, i) : '';
  const done = async (outcome: Outcome, result: CallToolResult, error?: string) => {
    await audit({ user, ctx, server: slug || null, tool: i > 0 ? name.slice(i + SEP.length) : name, ms: Date.now() - t0, outcome, error });
    return result;
  };
  const fail = (outcome: Outcome, msg: string) => done(outcome, { isError: true, content: [{ type: 'text', text: msg }] }, msg);

  const s = slug ? await getServer(slug) : undefined;
  if (!s) return fail('denied', `unknown tool '${name}'`);
  if (!s.enabled) return fail('denied', `server '${slug}' is disabled`);

  // Map the exposed name back to the upstream's original (names may have been sanitized/truncated).
  const original = s.tools.find((t) => t.exposed === name)?.name ?? name.slice(i + SEP.length);
  try {
    const result = await withUpstream(s, s.timeout_ms, (c, opts) => c.callTool({ name: original, arguments: args }, undefined, opts)) as CallToolResult;
    if (result.isError) return done('error', result, textOf(result));
    return done('ok', result);
  } catch (e) {
    if (e instanceof UpstreamError) {
      if (e.outcome === 'unreachable') await markUnreachable(s.id, e.message);
      return fail(e.outcome, e.message);
    }
    return fail('error', `upstream '${slug}' error: ${(e as Error).message}`);
  }
}

const textOf = (r: CallToolResult) => r.content?.map((c) => (c.type === 'text' ? c.text : '')).join(' ').slice(0, 500);

export async function audit(a: { user: Pick<User, 'id' | 'email'>; ctx: CallCtx; server: string | null; tool: string; ms: number; outcome: Outcome; error?: string }) {
  await q(
    `INSERT INTO audit_log (user_id, user_email, api_key_id, source, server_slug, tool_name, duration_ms, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [a.user.id, a.user.email, a.ctx.apiKeyId ?? null, a.ctx.source, a.server, a.tool, a.ms, a.outcome, a.error?.slice(0, 500) ?? null],
  ).catch((e) => console.error(JSON.stringify({ msg: 'audit write failed', error: String(e) })));
}
