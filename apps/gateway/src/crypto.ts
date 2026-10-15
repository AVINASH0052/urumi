import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// Passwords: scrypt (built into Node, no native module in the image).
export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scryptAsync(pw, salt, 32)).toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), 32);
  return timingSafeEqual(got, Buffer.from(hash, 'base64'));
}

// API keys: mcpgw_<prefix>_<secret>. 256-bit random, so a fast hash is enough (no brute force possible).
export function newApiKey() {
  const prefix = randomBytes(6).toString('hex').slice(0, 8);
  const key = `mcpgw_${prefix}_${randomToken(32)}`;
  return { key, prefix, hash: sha256(key) };
}
export function parseApiKey(key: string) {
  const m = /^mcpgw_([0-9a-f]{8})_[A-Za-z0-9_-]{20,}$/.exec(key);
  return m ? { prefix: m[1], hash: sha256(key) } : null;
}
export const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Upstream credentials at rest: AES-256-GCM, iv.tag.ciphertext.
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.credentialsKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
export function decrypt(blob: string) {
  const [iv, tag, ct] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', config.credentialsKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// Dashboard session cookie: base64url(json).hmac. 12 h; user status is re-checked on every request.
export function signSession(userId: string, ttlMs = 12 * 3600_000) {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${createHmac('sha256', config.sessionSecret).update(body).digest('base64url')}`;
}
export function verifySession(token: string | undefined): string | null {
  const [body, mac] = (token ?? '').split('.');
  if (!body || !mac) return null;
  if (!sameHash(mac, createHmac('sha256', config.sessionSecret).update(body).digest('base64url'))) return null;
  const { uid, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
  return exp > Date.now() ? uid : null;
}
