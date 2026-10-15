// Tiny fetch wrapper: same-origin cookie auth, JSON in/out, errors as Error(message).
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? res.statusText), { status: res.status });
  return data;
}

export type Me = { id: string; email: string; name: string; role: 'admin' | 'member' };
export type Server = {
  id: string; slug: string; name: string; enabled: boolean; status: 'connected' | 'unreachable' | 'disabled' | 'unknown';
  lastError: string | null; lastCheckedAt: string | null; tools: { name: string; description: string }[];
  url?: string; authType?: 'none' | 'bearer' | 'header'; authHeaderName?: string | null; hasCredential?: boolean; timeoutMs?: number;
};
export type ToolTrace = { name: string; args: unknown; isError: boolean; ms: number; preview: string };

export const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(iso).toLocaleString();
};
