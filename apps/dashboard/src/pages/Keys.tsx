import { useEffect, useState, type FormEvent } from 'react';
import { ago, api } from '../api.ts';

type Key = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

export function Keys() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Key[]>('/keys').then(setKeys, (e) => setErr(e.message));
  useEffect(() => void load(), []);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const k = await api<{ key: string }>('/keys', { body: { name: new FormData(form).get('name') } });
      setFresh(k.key); form.reset(); void load();
    } catch (x) { setErr((x as Error).message); }
  };
  const gw = `${location.origin}/mcp`;

  return (
    <>
      <h3>My API keys</h3>
      <form onSubmit={create} className="row">
        <input name="name" placeholder="Key name, e.g. laptop-claude-code" required style={{ flex: 1 }} />
        <button type="submit">Create key</button>
      </form>
      {fresh && (
        <article>
          <strong>Copy this key now. It won't be shown again.</strong>
          <pre className="secret">{fresh}</pre>
          <p>Claude Code:</p>
          <pre className="secret">{`claude mcp add --transport http urumi ${gw} --header "Authorization: Bearer ${fresh}"`}</pre>
          <button className="secondary" onClick={() => setFresh(null)}>Done</button>
        </article>
      )}
      {err && <p className="error">{err}</p>}
      <table>
        <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td><code>mcpgw_{k.prefix}_…</code></td>
              <td>{ago(k.created_at)}</td>
              <td>{ago(k.last_used_at)}</td>
              <td>{k.revoked_at ? <span className="muted">revoked {ago(k.revoked_at)}</span>
                : <button className="outline contrast" onClick={() => api(`/keys/${k.id}`, { method: 'DELETE' }).then(load, (e) => setErr(e.message))}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
