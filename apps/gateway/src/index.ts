import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { migrate, pool, q } from './db.ts';
import { encrypt, hashPassword } from './crypto.ts';
import { api, errorHandler } from './api.ts';
import { apiKeyAuth } from './auth.ts';
import { mcpCors, mcpHandler } from './mcp.ts';
import { startPoller } from './upstream.ts';

const log = (o: object) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

async function bootstrap() {
  await migrate();
  const { email, password } = config.bootstrapAdmin;
  if (email && password && (await q('SELECT 1 FROM users LIMIT 1')).length === 0) {
    await q(`INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)`, [email.toLowerCase(), await hashPassword(password)]);
    log({ msg: 'bootstrap admin created', email });
  }
  // Seed each server once ever: admin edits are never overwritten and removals stick.
  for (const s of config.seedServers) {
    if ((await q(`INSERT INTO seeded_servers (slug) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slug`, [s.slug])).length === 0) continue;
    const cred = s.credentialEnv ? process.env[s.credentialEnv] : undefined;
    const r = await q(`INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (slug) DO NOTHING RETURNING slug`, [s.slug, s.name, s.url, s.authType, s.authHeaderName ?? null, cred ? encrypt(cred) : null]);
    if (r.length) log({ msg: 'seeded server', slug: s.slug });
  }
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => void res.send('ok'));
app.get('/readyz', async (_req, res) => {
  try { await q('SELECT 1'); res.send('ok'); } catch { res.status(503).send('db unavailable'); }
});

app.use('/mcp', mcpCors);
app.post('/mcp', express.json({ limit: '1mb' }), apiKeyAuth, mcpHandler);
app.all('/mcp', (_req, res) => void res.status(405).set('Allow', 'POST').end());   // stateless: no GET stream / DELETE session

app.use('/api', express.json({ limit: '1mb' }), api);

// Dashboard (built React app), with SPA fallback.
const ui = fileURLToPath(new URL('../public/', import.meta.url));
if (existsSync(ui)) {
  app.use(express.static(ui));
  app.get(/^\/(?!api|mcp).*/, (_req, res) => res.sendFile('index.html', { root: ui }));
}
app.use(errorHandler);

await bootstrap();
const stopPoller = startPoller();
const server = app.listen(config.port, () => log({ msg: `gateway listening on :${config.port}` }));
process.on('SIGTERM', () => {
  stopPoller();                    // release poller leadership first
  server.close(() => void pool.end().then(() => process.exit(0)));
  server.closeIdleConnections();   // don't wait for idle keep-alive sockets
  setTimeout(() => process.exit(0), 10_000).unref();
});
