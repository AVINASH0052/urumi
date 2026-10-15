import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';

export function Login({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api('/auth/login', { body: { email: f.get('email'), password: f.get('password') } }); onDone(); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <main className="container" style={{ maxWidth: 420 }}>
      <h2>Urumi MCP Gateway</h2>
      <form onSubmit={submit}>
        <input name="email" type="email" placeholder="Email" required autoFocus />
        <input name="password" type="password" placeholder="Password" required />
        {err && <p className="error">{err}</p>}
        <button type="submit">Log in</button>
      </form>
    </main>
  );
}

export function Invite({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ email: string; role: string } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/invites/${token}`).then(setInvite, (e) => setErr(e.message)); }, [token]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api(`/invites/${token}/accept`, { body: { name: f.get('name'), password: f.get('password') } }); onDone(); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <main className="container" style={{ maxWidth: 420 }}>
      <h2>Join the team</h2>
      {invite && <p>Invited as <strong>{invite.email}</strong> ({invite.role}).</p>}
      {invite && (
        <form onSubmit={submit}>
          <input name="name" placeholder="Your name" required autoFocus />
          <input name="password" type="password" placeholder="Choose a password (8+ characters)" minLength={8} required />
          <button type="submit">Create account</button>
        </form>
      )}
      {err && <p className="error">{err}</p>}
    </main>
  );
}
