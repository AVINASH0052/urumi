const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || (v === '' && fallback === undefined)) throw new Error(`${k} is required`);   // '' is a valid explicit default
  return v;
};

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL'),
  sessionSecret: env('SESSION_SECRET'),
  credentialsKey: Buffer.from(env('CREDENTIALS_KEY'), 'base64'),   // 32 bytes
  publicUrl: env('PUBLIC_URL', 'http://app.localtest.me'),
  secureCookies: env('SECURE_COOKIES', 'false') === 'true',
  bootstrapAdmin: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
  seedServers: JSON.parse(env('SEED_SERVERS', '[]')) as SeedServer[],
  pollMs: Number(env('POLL_MS', '10000')),
  // Exact hostnames an admin may register although they resolve to private/cluster IPs.
  ssrfAllowedHosts: env('SSRF_ALLOWED_HOSTS', '').split(',').map((h) => h.trim()).filter(Boolean),
  llm: { baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, apiKey: process.env.LLM_API_KEY },
};
if (config.credentialsKey.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64');

export type SeedServer = { slug: string; name: string; url: string; authType: 'none' | 'bearer' | 'header'; authHeaderName?: string; credentialEnv?: string };
