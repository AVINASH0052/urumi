import { useEffect, useState, type FormEvent } from 'react';
import { ago, api } from '../api.ts';

type Member = { id: string; email: string; name: string; role: 'admin' | 'member'; status: 'active' | 'disabled'; created_at: string; active_keys: number };
type Key = { id: string; name: string; prefix: string; user_email: string; last_used_at: string | null; revoked_at: string | null };

export function Members() {
  const [members, setMembers] = useState<Member[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [link, setLink] = useState('');
  const [err, setErr] = useState('');
  const load = () => Promise.all([api<Member[]>('/members').then(setMembers), api<Key[]>('/keys?all=1').then(setKeys)]).catch((e) => setErr(e.message));
  useEffect(() => void load(), []);
  const act = (p: Promise<unknown>) => p.then(load, (e) => setErr(e.message));

  const invite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { setLink((await api<{ url: string }>('/invites', { body: { email: f.get('email'), role: f.get('role') } })).url); }
    catch (x) { setErr((x as Error).message); }
  };

  return (
    <>
      <h3>Members</h3>
      <form onSubmit={invite} className="row">
        <input name="email" type="email" placeholder="teammate@example.com" required style={{ flex: 1 }} />
        <select name="role" style={{ width: 'auto' }}><option value="member">member</option><option value="admin">admin</option></select>
        <button type="submit">Invite</button>
      </form>
      {link && <article><strong>Send this invite link (valid 72 h, single use):</strong><pre className="secret">{link}</pre></article>}
      {err && <p className="error" onClick={() => setErr('')}>{err}</p>}
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Active keys</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.name}<br /><small className="muted">{m.email}</small></td>
              <td>{m.role}</td>
              <td>{m.status}</td>
              <td>{m.active_keys}</td>
              <td className="row">
                <button className="outline secondary" onClick={() => act(api(`/members/${m.id}`, { method: 'PATCH', body: { role: m.role === 'admin' ? 'member' : 'admin' } }))}>
                  Make {m.role === 'admin' ? 'member' : 'admin'}
                </button>
                <button className="outline contrast" onClick={() => act(api(`/members/${m.id}`, { method: 'PATCH', body: { status: m.status === 'active' ? 'disabled' : 'active' } }))}>
                  {m.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>All API keys</h4>
      <table>
        <thead><tr><th>Owner</th><th>Name</th><th>Key</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.user_email}</td><td>{k.name}</td><td><code>mcpgw_{k.prefix}_…</code></td><td>{ago(k.last_used_at)}</td>
              <td>{k.revoked_at ? <span className="muted">revoked</span>
                : <button className="outline contrast" onClick={() => act(api(`/keys/${k.id}`, { method: 'DELETE' }))}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
