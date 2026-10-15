export function Connect() {
  const url = `${location.origin}/mcp`;
  const key = 'mcpgw_xxxxxxxx_…';
  return (
    <>
      <h3>Connect an MCP client</h3>
      <p>One URL and your own API key (create it under <a href="#keys">My API keys</a>). You get the tools of every enabled server, named <code>&lt;server&gt;__&lt;tool&gt;</code>. You never need the upstream servers' credentials.</p>
      <h5>Claude Code</h5>
      <pre className="secret">{`claude mcp add --transport http urumi ${url} \\\n  --header "Authorization: Bearer ${key}"`}</pre>
      <h5>Cursor (~/.cursor/mcp.json)</h5>
      <pre className="secret">{JSON.stringify({ mcpServers: { urumi: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}</pre>
      <h5>MCP Inspector</h5>
      <pre className="secret">{`npx @modelcontextprotocol/inspector\n# Transport: Streamable HTTP · URL: ${url}\n# Header: Authorization: Bearer ${key}`}</pre>
      <p className="muted">Tool lists are fetched when a client connects. After an admin disables a server, reconnect (Claude Code: <code>/mcp</code>) or click “List Tools” in Inspector.</p>
    </>
  );
}
