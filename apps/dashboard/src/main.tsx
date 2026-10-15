import '@picocss/pico/css/pico.min.css';
import './style.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type Me } from './api.ts';
import { Servers } from './pages/Servers.tsx';
import { Chat } from './pages/Chat.tsx';
import { Keys } from './pages/Keys.tsx';
import { Members } from './pages/Members.tsx';
import { Audit } from './pages/Audit.tsx';
import { Connect } from './pages/Connect.tsx';
import { Login, Invite } from './pages/Auth.tsx';

const PAGES = [
  { id: 'servers', label: 'Servers', el: (me: Me) => <Servers me={me} /> },
  { id: 'chat', label: 'Chat', el: () => <Chat /> },
  { id: 'keys', label: 'My API keys', el: () => <Keys /> },
  { id: 'connect', label: 'Connect', el: () => <Connect /> },
  { id: 'audit', label: 'Audit log', el: (me: Me) => <Audit me={me} /> },
  { id: 'members', label: 'Members', el: () => <Members />, admin: true },
];

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const hash = useHash();
  const load = () => api<Me>('/me').then(setMe, () => setMe(null));
  useEffect(() => void load(), []);

  const invite = /^\/invite\/([\w-]+)$/.exec(location.pathname)?.[1];
  if (invite) return <Invite token={invite} onDone={() => { history.replaceState(null, '', '/'); void load(); }} />;
  if (me === undefined) return <main className="container" aria-busy="true" />;
  if (me === null) return <Login onDone={load} />;

  const pages = PAGES.filter((p) => !p.admin || me.role === 'admin');
  const page = pages.find((p) => p.id === hash) ?? pages[0];
  return (
    <>
      <header className="container">
        <nav>
          <ul><li><strong>Urumi MCP Gateway</strong></li></ul>
          <ul>
            {pages.map((p) => (
              <li key={p.id}><a href={`#${p.id}`} aria-current={p === page ? 'page' : undefined}>{p.label}</a></li>
            ))}
            <li>
              <small>{me.email} ({me.role})</small>{' '}
              <a href="#" onClick={async (e) => { e.preventDefault(); await api('/auth/logout', { method: 'POST' }); setMe(null); }}>Log out</a>
            </li>
          </ul>
        </nav>
      </header>
      <main className="container">{page.el(me)}</main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
