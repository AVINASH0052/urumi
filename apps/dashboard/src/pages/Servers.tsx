import { useEffect, useState, type FormEvent } from 'react';
import { ago, api, type Me, type Server } from '../api.ts';

export function Servers({ me }: { me: Me }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const admin = me.role === 'admin';
  const load = () => api<Server[]>('/servers').then(setServers, (e) => setErr(e.message));
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const act = (p: Promise<unknown>) => p.then(load, (e) => setErr(e.message));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>MCP servers</h3>
        {admin && <button onClick={() => setEditing('new')}>Add server</button>}
      </div>
      {err && <p className="error" onClick={() => setErr('')}>{err}</p>}
      {editing && <ServerForm server={editing === 'new' ? null : editing} onClose={() => { setEditing(null); void load(); }} />}
      <table>
        <thead><tr><th>Server</th><th>Status</th><th>Tools</th>{admin && <th>Endpoint</th>}{admin && <th />}</tr></thead>
        <tbody>
          {servers.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><br /><code>{s.slug}</code></td>
              <td>
                <span className={`badge ${s.status}`}>{s.status === 'unknown' ? 'checking' : s.status}</span>
                <br /><small className="muted">checked {ago(s.lastCheckedAt)}</small>
                {s.lastError && <><br /><small className="error">{s.lastError}</small></>}
              </td>
              <td>
                <details>
                  <summary>{s.tools.length} tools</summary>
                  <ul>{s.tools.map((t) => <li key={t.name}><code>{t.name}</code> <small className="muted">{t.description.slice(0, 120)}</small></li>)}</ul>
                </details>
              </td>
              {admin && (
                <td><small><code>{s.url}</code><br />auth: {s.authType}{s.hasCredential ? ' (credential set)' : ''} · timeout {s.timeoutMs} ms</small></td>
              )}
              {admin && (
                <td>
                  <div className="row">
                    <button className="outline" onClick={() => act(api(`/servers/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }))}>
                      {s.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="outline secondary" onClick={() => act(api(`/servers/${s.id}/refresh`, { method: 'POST' }))}>Refresh</button>
                    <button className="outline secondary" onClick={() => setEditing(s)}>Edit</button>
                    <button className="outline contrast" onClick={() => confirm(`Remove ${s.name}?`) && act(api(`/servers/${s.id}`, { method: 'DELETE' }))}>Remove</button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!admin && <p className="muted">Only admins can add or change servers. Upstream credentials are never shown to anyone.</p>}
    </>
  );
}

function ServerForm({ server, onClose }: { server: Server | null; onClose: () => void }) {
  const [authType, setAuthType] = useState(server?.authType ?? 'none');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body: Record<string, unknown> = {
      name: f.name, url: f.url, authType, timeoutMs: Number(f.timeoutMs),
      ...(authType === 'header' && { authHeaderName: f.authHeaderName }),
      ...(f.credential && { credential: f.credential }),   // empty = keep the stored one
      ...(authType === 'none' && server?.hasCredential && { credential: null }),
    };
    if (!server) body.slug = f.slug;
    setBusy(true);
    try { await api(server ? `/servers/${server.id}` : '/servers', { method: server ? 'PATCH' : 'POST', body }); onClose(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <article>
      <header><strong>{server ? `Edit ${server.name}` : 'Add an MCP server (Streamable HTTP)'}</strong></header>
      <form onSubmit={submit}>
        <div className="grid">
          <label>Name<input name="name" defaultValue={server?.name} required /></label>
          <label>Slug (tool prefix, can't change later)
            <input name="slug" defaultValue={server?.slug} disabled={!!server} pattern="[a-z][a-z0-9-]{1,30}" required={!server} />
          </label>
        </div>
        <label>URL<input name="url" type="url" defaultValue={server?.url} placeholder="https://example.com/mcp" required /></label>
        <div className="grid">
          <label>Auth
            <select value={authType} onChange={(e) => setAuthType(e.target.value as typeof authType)}>
              <option value="none">None</option><option value="bearer">Bearer token</option><option value="header">Custom header</option>
            </select>
          </label>
          {authType === 'header' && <label>Header name<input name="authHeaderName" defaultValue={server?.authHeaderName ?? ''} placeholder="X-API-Key" required /></label>}
          {authType !== 'none' && (
            <label>Credential
              <input name="credential" type="password" autoComplete="off" placeholder={server?.hasCredential ? 'stored (leave empty to keep)' : ''} required={!server?.hasCredential} />
            </label>
          )}
          <label>Timeout (ms)<input name="timeoutMs" type="number" min={1000} max={120000} defaultValue={server?.timeoutMs ?? 15000} /></label>
        </div>
        {err && <p className="error">{err}</p>}
        <div className="row">
          <button type="submit" aria-busy={busy}>{server ? 'Save' : 'Add and connect'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </article>
  );
}
