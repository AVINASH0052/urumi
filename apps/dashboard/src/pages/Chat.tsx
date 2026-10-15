import { useState, type FormEvent } from 'react';
import { api, type ToolTrace } from '../api.ts';

type Turn = { role: 'user' | 'assistant'; content: string; toolCalls?: ToolTrace[] };

// History lives in the browser only; the agent runs server-side as the logged-in user.
export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get('q') ?? '').trim();
    if (!text) return;
    const next = [...turns, { role: 'user' as const, content: text }];
    setTurns(next); setBusy(true); setErr(''); form.reset();
    try {
      const r = await api<{ reply: string; toolCalls: ToolTrace[] }>('/chat', { body: { messages: next.map(({ role, content }) => ({ role, content })) } });
      setTurns([...next, { role: 'assistant', content: r.reply, toolCalls: r.toolCalls }]);
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>Chat</h3>
        {turns.length > 0 && <button className="outline secondary" onClick={() => setTurns([])}>New chat</button>}
      </div>
      <p className="muted">Answers come from tools on the gateway, called as you. Every call shows up in the audit log.
        Try: <em>“Create a product called Demo Mug priced 12.50”</em> or <em>“What orders came in today, and their total in EUR?”</em></p>
      <div className="chat">
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role}`}>
            {t.toolCalls?.map((c, j) => (
              <details key={j} className={`tool ${c.isError ? 'err' : ''}`}>
                <summary>🔧 <code>{c.name}</code> · {c.ms} ms{c.isError ? ' · error' : ''}</summary>
                <pre>{JSON.stringify(c.args, null, 2)}</pre>
                <pre>{c.preview}</pre>
              </details>
            ))}
            {t.content}
          </div>
        ))}
        {busy && <div className="msg assistant" aria-busy="true">Thinking…</div>}
      </div>
      {err && <p className="error">{err}</p>}
      <form onSubmit={send} className="row" style={{ marginTop: '1rem' }}>
        <input name="q" placeholder="Ask about products and orders…" autoComplete="off" style={{ flex: 1 }} disabled={busy} />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </>
  );
}
