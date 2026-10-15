import type { NextFunction, Request, Response } from 'express';
import { q } from './db.ts';
import { parseApiKey, sameHash, verifySession } from './crypto.ts';
import { audit, type User } from './core.ts';
import { config } from './config.ts';

const unauthorized = (res: Response, msg: string) =>
  res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: { code: 'unauthorized', message: msg } });

// /mcp: Authorization: Bearer mcpgw_<prefix>_<secret>
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const raw = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const parsed = parseApiKey(raw);
  if (!parsed) return unauthorized(res, 'missing or malformed API key');
  const [k] = await q(
    `SELECT k.id, k.key_hash, k.revoked_at, u.id AS user_id, u.email, u.role, u.status
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.prefix = $1`, [parsed.prefix]);
  if (!k || !sameHash(k.key_hash, parsed.hash)) return unauthorized(res, 'invalid API key');
  if (k.revoked_at || k.status !== 'active') {
    // We know who this is, so the rejected call is still attributed in the audit log.
    if (req.body?.method === 'tools/call')
      await audit({ user: { id: k.user_id, email: k.email }, ctx: { source: 'mcp', apiKeyId: k.id }, server: null,
        tool: String(req.body?.params?.name ?? ''), ms: 0, outcome: 'denied', error: k.revoked_at ? 'API key revoked' : 'user disabled' });
    return unauthorized(res, k.revoked_at ? 'API key revoked' : 'user disabled');
  }
  void q(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [k.id]);
  res.locals.user = { id: k.user_id, email: k.email, role: k.role } satisfies User;
  res.locals.apiKeyId = k.id;
  next();
}

// Dashboard: HttpOnly session cookie. User status is re-checked on every request.
export async function sessionAuth(req: Request, res: Response, next: NextFunction) {
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith('sid='))?.slice(4);
  const uid = verifySession(cookie);
  const [u] = uid ? await q(`SELECT id, email, name, role FROM users WHERE id = $1 AND status = 'active'`, [uid]) : [];
  if (!u) return res.status(401).json({ error: { code: 'unauthorized', message: 'login required' } });
  res.locals.user = u;
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if (res.locals.user?.role !== 'admin') return res.status(403).json({ error: { code: 'forbidden', message: 'admin only' } });
  next();
}

export const sessionCookie = (token: string, maxAge = 12 * 3600) =>
  `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
