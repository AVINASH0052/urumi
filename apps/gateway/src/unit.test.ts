// Fast unit tests for the pure logic: naming, schema cleanup, crypto. Run: npm test -w apps/gateway
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unused';
process.env.SESSION_SECRET ??= 'test-secret';
process.env.CREDENTIALS_KEY ??= Buffer.alloc(32, 7).toString('base64');
const { exposedName } = await import('./upstream.ts');
const { sanitizeSchema } = await import('./chat.ts');
const c = await import('./crypto.ts');

test('tool names are prefixed, sanitized and capped at 64 chars', () => {
  assert.equal(exposedName('woo', 'list_orders'), 'woo__list_orders');
  assert.equal(exposedName('x', 'a.b/c d'), 'x__a_b_c_d');
  const long = exposedName('everything', 'a'.repeat(80));
  assert.equal(long.length, 64);
  assert.match(long, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.notEqual(long, exposedName('everything', 'a'.repeat(81)));   // hash keeps them distinct
});

test('schema sanitizer drops keywords LLM providers reject, keeps structure', () => {
  const out = sanitizeSchema({
    $schema: 'x', type: 'object', additionalProperties: false,
    properties: { default: { type: 'string', default: 'a' }, n: { type: 'integer', exclusiveMinimum: 0 } },
    required: ['n'],
  });
  assert.deepEqual(out, { type: 'object', properties: { default: { type: 'string' }, n: { type: 'integer' } }, required: ['n'] });
});

test('API keys: format, parse, hash', () => {
  const k = c.newApiKey();
  assert.match(k.key, /^mcpgw_[0-9a-f]{8}_[\w-]{43}$/);
  assert.deepEqual(c.parseApiKey(k.key), { prefix: k.prefix, hash: k.hash });
  assert.equal(c.parseApiKey('Bearer nope'), null);
});

test('credentials encrypt/decrypt round-trip and are tamper-evident', () => {
  const blob = c.encrypt('s3cret');
  assert.notEqual(blob, 's3cret');
  assert.equal(c.decrypt(blob), 's3cret');
  const [iv, tag, ct] = blob.split('.');
  assert.throws(() => c.decrypt([iv, tag, Buffer.from('x' + ct).toString('base64')].join('.')));
});

test('passwords and sessions', async () => {
  const h = await c.hashPassword('hunter22');
  assert.ok(await c.verifyPassword('hunter22', h));
  assert.ok(!(await c.verifyPassword('hunter23', h)));
  const s = c.signSession('u1');
  assert.equal(c.verifySession(s), 'u1');
  assert.equal(c.verifySession(s.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))), null);
  assert.equal(c.verifySession(c.signSession('u1', -1)), null);
});

test('SSRF guard: metadata, private, loopback and IPv4-mapped IPv6 are refused', async () => {
  const { assertSafeUrl } = await import('./ssrf.ts');
  for (const u of ['http://169.254.169.254/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:10.0.0.1]/', 'http://10.1.2.3/', 'http://127.0.0.1/', 'http://[::1]/', 'file:///etc/passwd'])
    await assert.rejects(assertSafeUrl(u), Error, u);
  await assertSafeUrl('http://93.184.215.14/mcp');   // public IP is fine
});

test('chat retries: delay from Retry-After header or the provider message', async () => {
  const { retryDelayMs } = await import('./chat.ts');
  assert.equal(retryDelayMs(new Response(null, { headers: { 'retry-after': '3' } }), null), 3000);
  assert.equal(retryDelayMs(new Response(null), { message: 'Please try again in 3.4275s. Need more tokens?' }), 3427.5);
  assert.equal(retryDelayMs(new Response(null), { message: 'try again in 850ms' }), 850);
  assert.equal(retryDelayMs(new Response(null), { message: 'slow down' }), 2000);
});
