// REST API for the dashboard (session cookie auth).
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { q } from './db.ts';
import { encrypt, hashPassword, newApiKey, randomToken, sha256, signSession, verifyPassword } from './crypto.ts';
import { requireAdmin, sessionAuth, sessionCookie } from './auth.ts';
import { assertSafeUrl } from './ssrf.ts';
import { refresh, type ServerRow } from './upstream.ts';
import { config } from './config.ts';
import { chat } from './chat.ts';

export const api = Router();

const parse = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'invalid_input', z.prettifyError(r.error));
  return r.data;
};
export class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const DUMMY_HASH = await hashPassword(randomToken());
const me = (res: Response) => res.locals.user as { id: string; email: string; name: string; role: 'admin' | 'member' };

// ---------- auth ----------

api.post('/auth/login', async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string(), password: z.string() }), req.body);
  const [u] = await q(`SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND status = 'active'`, [email]);
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);   // constant work: no user enumeration by timing
  if (!u || !ok) throw new HttpError(401, 'unauthorized', 'wrong email or password');
  res.set('Set-Cookie', sessionCookie(signSession(u.id))).json({ ok: true });
});
api.post('/auth/logout', (_req, res) => void res.set('Set-Cookie', sessionCookie('', 0)).json({ ok: true }));

// Invite acceptance happens before login.
api.get('/invites/:token', async (req, res) => {
  const [i] = await q(`SELECT email, role FROM invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`, [sha256(req.params.token)]);
  if (!i) throw new HttpError(404, 'not_found', 'invite is invalid or expired');
  res.json(i);
});
api.post('/invites/:token/accept', async (req, res) => {
  const body = parse(z.object({ name: z.string().min(1).max(100), password: z.string().min(8).max(200) }), req.body);
  const [i] = await q(`UPDATE invites SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING email, role`, [sha256(req.params.token)]);
  if (!i) throw new HttpError(404, 'not_found', 'invite is invalid or expired');
  const [u] = await q(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [i.email, body.name, i.role, await hashPassword(body.password)]);
  if (!u) throw new HttpError(409, 'conflict', 'a user with this email already exists');
  res.set('Set-Cookie', sessionCookie(signSession(u.id))).json({ ok: true });
});

// Everything below needs a session.
api.use(sessionAuth);

api.get('/me', (_req, res) => void res.json(me(res)));

// ---------- servers ----------

function serverView(s: ServerRow, admin: boolean) {
  return {
    id: s.id, slug: s.slug, name: s.name, enabled: s.enabled,
    status: s.enabled ? s.status : 'disabled', lastError: s.enabled ? s.last_error : null, lastCheckedAt: s.last_checked_at,
    tools: s.tools.map((t) => ({ name: t.exposed, description: t.description ?? '' })),
    // Members see what they can use, not where it lives or how it authenticates.
    ...(admin && { url: s.url, authType: s.auth_type, authHeaderName: s.auth_header_name, hasCredential: !!s.credential_enc, timeoutMs: s.timeout_ms }),
  };
}

const serverInput = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  authType: z.enum(['none', 'bearer', 'header']),   // no .default(): .partial() would still apply it on PATCH
  authHeaderName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullish(),
  credential: z.string().max(4096).nullish(),   // write-only: undefined = keep, null/'' = clear
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  enabled: z.boolean().optional(),
});

async function checkUrl(url: string) {
  try { await assertSafeUrl(url); } catch (e) { throw new HttpError(400, 'unsafe_url', (e as Error).message); }
}
async function loadAndRefresh(id: string) {
  const [s] = await q<ServerRow>('SELECT * FROM servers WHERE id = $1', [id]);
  if (!s) throw new HttpError(404, 'not_found', 'server not found');
  await refresh(s);
  return (await q<ServerRow>('SELECT * FROM servers WHERE id = $1', [id]))[0];
}

api.get('/servers', async (_req, res) => {
  const rows = await q<ServerRow>('SELECT * FROM servers ORDER BY created_at');
  res.json(rows.map((s) => serverView(s, me(res).role === 'admin')));
});

api.post('/servers', requireAdmin, async (req, res) => {
  const b = parse(serverInput.extend({
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lowercase letters, digits, dashes'),
    authType: serverInput.shape.authType.default('none'),
  }), req.body);
  await checkUrl(b.url);
  const [s] = await q(
    `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, timeout_ms, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [b.slug, b.name, b.url, b.authType, b.authHeaderName ?? null, b.credential ? encrypt(b.credential) : null, b.timeoutMs ?? 15000, b.enabled ?? true]);
  if (!s) throw new HttpError(409, 'conflict', `slug '${b.slug}' is taken`);
  res.status(201).json(serverView(await loadAndRefresh(s.id), true));
});

api.patch('/servers/:id', requireAdmin, async (req, res) => {
  const b = parse(serverInput.partial().strict(), req.body);   // .strict(): slug can't be changed
  if (b.url) await checkUrl(b.url);
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) set('name', b.name);
  if (b.url !== undefined) set('url', b.url);
  if (b.authType !== undefined) set('auth_type', b.authType);
  if (b.authHeaderName !== undefined) set('auth_header_name', b.authHeaderName);
  if (b.credential !== undefined) set('credential_enc', b.credential ? encrypt(b.credential) : null);
  if (b.timeoutMs !== undefined) set('timeout_ms', b.timeoutMs);
  if (b.enabled !== undefined) set('enabled', b.enabled);
  if (b.enabled === true) set('status', 'unknown');
  if (sets.length) await q(`UPDATE servers SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  res.json(serverView(await loadAndRefresh(req.params.id as string), true));
});

api.delete('/servers/:id', requireAdmin, async (req, res) => {
  await q('DELETE FROM servers WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

api.post('/servers/:id/refresh', requireAdmin, async (req, res) => {
  res.json(serverView(await loadAndRefresh(req.params.id as string), true));
});

// ---------- API keys ----------

api.get('/keys', async (req, res) => {
  const all = req.query.all === '1' && me(res).role === 'admin';
  res.json(await q(
    `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS user_email
       FROM api_keys k JOIN users u ON u.id = k.user_id ${all ? '' : 'WHERE k.user_id = $1'} ORDER BY k.created_at DESC`,
    all ? [] : [me(res).id]));
});

api.post('/keys', async (req, res) => {
  const { name } = parse(z.object({ name: z.string().min(1).max(100) }), req.body);
  const k = newApiKey();
  const [row] = await q(`INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at`,
    [me(res).id, name, k.prefix, k.hash]);
  res.status(201).json({ ...row, key: k.key });   // the only time the full key is ever shown
});

api.delete('/keys/:id', async (req, res) => {
  const admin = me(res).role === 'admin';
  const rows = await q(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL ${admin ? '' : 'AND user_id = $2'} RETURNING id`,
    admin ? [req.params.id] : [req.params.id, me(res).id]);
  if (!rows.length) throw new HttpError(404, 'not_found', 'key not found or already revoked');
  res.status(204).end();
});

// ---------- members & invites (admin) ----------

api.get('/members', requireAdmin, async (_req, res) => {
  res.json(await q(`SELECT u.id, u.email, u.name, u.role, u.status, u.created_at,
    (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS active_keys
    FROM users u ORDER BY u.created_at`));
});

api.patch('/members/:id', requireAdmin, async (req, res) => {
  const b = parse(z.object({ role: z.enum(['admin', 'member']).optional(), status: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
  if (req.params.id === me(res).id) throw new HttpError(400, 'invalid_input', "you can't change your own role or status");
  const [u] = await q(`UPDATE users SET role = coalesce($2, role), status = coalesce($3, status) WHERE id = $1 RETURNING id, email, role, status`,
    [req.params.id, b.role ?? null, b.status ?? null]);
  if (!u) throw new HttpError(404, 'not_found', 'user not found');
  res.json(u);
});

api.post('/invites', requireAdmin, async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), role: z.enum(['admin', 'member']).default('member') }), req.body);
  const token = randomToken(24);
  const [i] = await q(`INSERT INTO invites (email, role, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '72 hours') RETURNING expires_at`,
    [b.email.toLowerCase(), b.role, sha256(token), me(res).id]);
  // No SMTP on purpose: the admin copies the link.
  res.status(201).json({ url: `${config.publicUrl}/invite/${token}`, token, expiresAt: i.expires_at });
});

// ---------- audit log ----------

api.get('/audit', async (req, res) => {
  const f = parse(z.object({
    userId: z.string().uuid().optional(), server: z.string().optional(), outcome: z.string().optional(),
    before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
  }), req.query);
  if (me(res).role !== 'admin') f.userId = me(res).id;   // members see only their own calls
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  if (f.userId) add('user_id = ?', f.userId);
  if (f.server) add('server_slug = ?', f.server);
  if (f.outcome) add('outcome = ?', f.outcome);
  if (f.before) add('id < ?', f.before);
  vals.push(f.limit);
  res.json(await q(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${vals.length}`, vals));
});

// ---------- chat agent ----------

api.post('/chat', async (req, res) => {
  const { messages } = parse(z.object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).min(1).max(50),
  }), req.body);
  try {
    res.json(await chat(me(res), messages));
  } catch (e) {
    throw new HttpError(502, 'llm_error', (e as Error).message);
  }
});

// ---------- errors ----------

export function errorHandler(err: unknown, _req: Request, res: Response, _next: unknown) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if ((err as any)?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'invalid_json', message: 'invalid JSON body' } });
  console.error(JSON.stringify({ msg: 'unhandled', error: String((err as Error)?.stack ?? err) }));
  res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
}
