import { useEffect, useState } from 'react';
import { api, type Me } from '../api.ts';

type Row = { id: number; at: string; user_email: string; source: 'mcp' | 'chat'; server_slug: string | null; tool_name: string; duration_ms: number; outcome: string; error: string | null };

export function Audit({ me }: { me: Me }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [server, setServer] = useState('');
  const [outcome, setOutcome] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const qs = new URLSearchParams({ limit: '200', ...(server && { server }), ...(outcome && { outcome }) });
    const load = () => api<Row[]>(`/audit?${qs}`).then(setRows, (e) => setErr(e.message));
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [server, outcome]);

  return (
    <>
      <h3>Audit log {me.role !== 'admin' && <small className="muted">(your calls)</small>}</h3>
      <div className="row">
        <input placeholder="Filter by server slug" value={server} onChange={(e) => setServer(e.target.value)} />
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All outcomes</option>
          {['ok', 'error', 'timeout', 'unreachable', 'denied'].map((o) => <option key={o}>{o}</option>)}
        </select>
      </div>
      {err && <p className="error">{err}</p>}
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Via</th><th>Server · tool</th><th>Duration</th><th>Outcome</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><small>{new Date(r.at).toLocaleString()}</small></td>
              <td>{r.user_email}</td>
              <td>{r.source}</td>
              <td><code>{r.server_slug ?? '—'}</code> · <code>{r.tool_name}</code></td>
              <td>{r.duration_ms} ms</td>
              <td>
                <span className={`badge ${r.outcome === 'ok' ? 'connected' : r.outcome === 'denied' ? 'disabled' : 'unreachable'}`}>{r.outcome}</span>
                {r.error && <><br /><small className="error">{r.error}</small></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
