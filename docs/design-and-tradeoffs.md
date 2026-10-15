# System design and tradeoffs

## Architecture

```
shopper ──► Traefik ──► store.<domain> ──► WordPress + WooCommerce ──► MariaDB
                                               ▲  WC REST v3 (in-cluster only)
                                               │
                                            woo-mcp ◄──┐
team browser ─► Traefik ─► app.<domain> ─► gateway ────┼──► utils-mcp
Claude Code / Cursor ───► app.<domain>/mcp   │  │      └──► everything-mcp
                                             │  └──► LLM API (chat agent)
                                             ▼
                                          Postgres
```

| Component | Responsibility | Exposure |
|---|---|---|
| WordPress + MariaDB (`charts/store`) | The store. An idempotent post-install/upgrade Job installs WooCommerce, enables COD and creates the REST key from a Secret | Storefront via Ingress. DB internal |
| woo-mcp | 5 tools over the WC REST API | ClusterIP. NetworkPolicy: gateway in, WordPress + DNS out |
| gateway (`charts/platform`) | MCP endpoint, MCP client to every upstream, REST API, dashboard, chat agent, audit | `app.<domain>` via Ingress |
| Postgres | Users, keys, servers + cached tool lists, audit log | Gateway only |
| utils-mcp, everything-mcp | Second and third upstreams | Gateway only |

Choices worth defending:
- **One language (TypeScript on Node 22, run without a build step)** and the official MCP SDK for every server and client.
- **The dashboard is bundled into the gateway image.** Same origin means `SameSite=Strict` cookies and no CORS for the UI. One fewer Deployment.
- **k3d locally, k3s on the VPS.** Same Traefik, `local-path` storage and NetworkPolicy enforcement, so the values files hold only real differences.
- **The store talks to WooCommerce over its REST API**, not WP-CLI or SQL. It's a versioned contract with WooCommerce's own permission checks, and the coupling is network-only, so a NetworkPolicy can enforce it. WC accepts key/secret Basic auth only when `is_ssl()`. WordPress gets the standard reverse-proxy line (`X-Forwarded-Proto: https` ⇒ HTTPS), which prod needs behind TLS anyway, and woo-mcp sends that header in-cluster. Through the public Ingress, Traefik overwrites the header, so the same request is refused (CI asserts the 401).

## Tool aggregation, routing, failure handling

**Naming.** Every tool is exposed as `<slug>__<tool>`. Slugs are unique and immutable, so collisions can't happen and names never change when servers are added. `__` keeps names valid for LLM APIs (`^[a-zA-Z0-9_-]{1,64}$`). Longer names are truncated with a hash suffix, and the cached tool list maps exposed names back to originals. `utils__echo` and `everything__echo` show a real collision.

**Listing** reads the cached tool lists in Postgres, filtered to `enabled AND connected`. No live fan-out happens, so a slow upstream can't slow down `tools/list`. A health poller refreshes every 10 s. Exactly one replica polls: whichever holds a Postgres advisory lock. On shutdown it gives up the lock first, so another replica takes over in about 1 s.

**Calling.** The gateway splits the name on the first `__`, loads the server (unknown or disabled → `denied`), decrypts its credential in memory, opens a short-lived MCP session, calls, ends the session (DELETE) and closes. One deadline (`timeout_ms`, per server) covers connect + call. Results:

| Failure | What the caller gets | Side effect |
|---|---|---|
| Timeout | `isError` result: `upstream 'x' timed out after Nms` | audited `timeout` |
| Connection refused, DNS, 5xx | `upstream 'x' unreachable: <cause>` | server marked unreachable at once, tools leave the list |
| Tool returned `isError` | passed through | audited `error` |
| Disabled / unknown | `server 'x' is disabled` | audited `denied` |

Upstream failures come back as tool results, not JSON-RPC errors, so a model can read them and recover. Other servers are unaffected because every call is independent.

**Why connect-per-operation instead of pooled sessions:** no stale session ids after an upstream restart, no reconnect state machine, nothing to keep consistent across replicas. Inside the cluster the extra `initialize` round-trip costs milliseconds. If latency ever mattered, the upgrade is an LRU of connected clients, evicted on error.

**Stateless gateway MCP (no session ids).** Any replica can serve any request, with no sticky sessions. The cost: the gateway can't push `notifications/tools/list_changed`, so external clients see tool changes when they re-list (Inspector "List Tools", Claude Code `/mcp`). Calls to removed tools get a clear `denied`. The chat agent re-lists every turn.

**Chat agent.** It's an OpenAI-compatible tool loop (8 rounds max). Its only tool access is the same `listTools` / `callTool` functions behind `/mcp`, called with the logged-in user, so permissions, timeouts and audit are identical (`source = chat`). Upstream JSON Schemas are stripped of keywords strict providers reject. The system prompt tells the model to treat tool output as data.

## What changes for production (values only)

| | local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| DNS | `*.localtest.me` → 127.0.0.1, no hosts file | A records `store.` / `app.` → VPS IP |
| Ingress | Traefik (k3d), HTTP | Traefik (k3s), TLS via cert-manager `letsencrypt-prod` |
| Storage | `local-path`, 1 Gi | `local-path` (single node) or Longhorn, 10 Gi |
| Secrets | generated by Helm on first install, reused via `lookup` | `existingSecret`, created out-of-band (README) |
| Gateway | 1 replica | 2 replicas + PodDisruptionBudget |
| Cookies | not `Secure` | `Secure` |
| Images | built locally, `k3d image import` | registry tags (CI-built) |

**Upgrades and rollback.** `helm upgrade` rolls the gateway with `maxUnavailable: 0`. Migrations are expand-only, so `helm rollback` to an older image still works against the newer schema. The store's setup Job re-runs on every upgrade: it applies a pinned WooCommerce version and runs `wp wc update`.

## Known limitations (stated, not hidden)
- No per-tool permissions yet: every member can call every enabled tool. See threat-model.md.
- The SSRF check resolves DNS and then the HTTP client resolves again. A DNS-rebinding attacker could swap the address between the two. Mitigations: admin-only registration, `redirect: 'error'`, and the NetworkPolicy blocking `169.254.169.254`.
- Stateless MCP can't push tool-list changes (see above).
- No login rate limiting yet. Passwords use scrypt, and timing doesn't reveal which accounts exist.
- WordPress runs a single replica (RWO volume). Scaling it needs RWX storage and offloaded media.
