# Threat model

**Assets:** upstream credentials (WC REST key, MCP bearer tokens), user API keys, store data (orders, customers), the audit log.
**Actors:** admins (trusted), members (authenticated, partially trusted), upstream MCP servers (untrusted output), the internet.

## How credentials are stored and move

| Secret | At rest | In transit | Who ever sees it |
|---|---|---|---|
| User API key `mcpgw_<prefix>_<secret>` | SHA-256 only (256-bit random, so a fast hash is enough) | client → gateway `Authorization` header | The owner, once, at creation |
| Dashboard password | scrypt | login POST | The user |
| Upstream credential | AES-256-GCM in Postgres. The key lives in a K8s Secret, not in the DB | gateway → that upstream only | Nobody. The API is write-only (`hasCredential: true`) |
| WC REST key, MCP tokens, DB passwords | K8s Secrets (generated or `existingSecret`) | in-cluster only | Pods that mount them |

## 1. Shared upstream credentials: what a member can do with a credential they never see

A member can use the WooCommerce key **only through the tools woo-mcp exposes**. That means list/create products and list/get/update orders. They can't delete customers, read settings, or call any WC endpoint we didn't wrap. Every use is audited under their name. Revoking their gateway key (or disabling their user) cuts them off immediately, and the shared credential doesn't need rotating. What they *can* do is everything those tools allow, for example changing any order's status. Today all members can call all tools. The next step is per-role tool policies (members read, admins write): hidden from `tools/list` and refused on call.

## 2. Why client tokens are not passed through to upstreams

The gateway strips the caller's `Authorization` header and attaches only the upstream's own static credential.
- **Confused deputy / replay.** A token valid at the gateway, handed to an upstream, lets a malicious or compromised upstream call the gateway as that user, and through it every other upstream. The MCP authorization spec forbids token passthrough for this reason.
- **Audience.** Upstreams don't know our users. Their credential is scoped to them, and ours to us.
- **Central control.** Revocation, audit and policy all happen in one place.

## 3. Untrusted upstreams: tool descriptions written to manipulate the model

A registered server controls its tool names, descriptions, schemas and results. That's a prompt-injection channel into the chat agent, and into users' own clients.
- **Only admins register servers.** The SSRF guard refuses metadata, loopback, private and cluster addresses (IPv4-mapped IPv6 included) unless explicitly allow-listed. Redirects are refused.
- **Namespacing** (`<slug>__`) means a malicious server can't shadow `woo__*` tools.
- **Descriptions** are prefixed with the server's name and capped at 1 KB. Tool results are capped at 8 KB in the chat.
- **The chat system prompt** says tool output is data, not instructions. That's a mitigation, not a guarantee.
- **The upstream sees only the arguments sent to it.** It never sees user identity, other servers' data or credentials.
- **Remaining risk:** a malicious server's output can still steer the model into calling *other* tools (e.g. `woo__update_order_status`) as the user. Mitigations are per-role tool policies, confirmation for write tools, and the audit log for detection. A compromised upstream is also network-confined: in-cluster upstreams can reach nothing but DNS, and woo-mcp only its own WordPress.

## 4. What one team member can do to another

- **Can't:** see another member's keys (only hashes are stored; others' keys aren't listed), revoke them, read their audit rows, change roles, or add, edit or remove servers (403).
- **Can:** affect shared state through shared credentials. An order status a member changes is changed for everyone. That's the honest consequence of shared upstream credentials. The audit log attributes every such call, and tool policies are the control to restrict writes.
- **Admins** can do everything, including revoking anyone. Admin compromise means platform compromise, by design. Keep admins few.

## Network boundaries (enforced by NetworkPolicy, verified in CI)

| From → To | Allowed |
|---|---|
| Internet → storefront, gateway | via Traefik only |
| gateway → woo-mcp, utils-mcp, everything-mcp, Postgres | yes |
| anything else → woo-mcp / upstreams / Postgres | no (CI: a random pod is blocked, a gateway-labelled pod is allowed) |
| woo-mcp → | its WordPress + DNS only |
| utils-mcp, everything-mcp → | DNS only |
| gateway → cloud metadata 169.254.169.254 | no |
| MariaDB ← | WordPress + setup Job only |

Containers we build run as non-root, with a read-only root filesystem and all capabilities dropped. The upstream images (WordPress, MariaDB, Postgres) run as their images require; this is documented. No pod mounts a ServiceAccount token, because nothing needs the Kubernetes API.
