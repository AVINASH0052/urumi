# Bonus and stand-out items

Status as of this commit. "Partial" means part of the item is done and the rest is listed.

| Item | Status | Where |
|---|---|---|
| **6. Security hardening** | **Done** (except RBAC, which isn't needed yet) | SSRF guard on admin URLs, checked at save and at connect, including IPv4-mapped IPv6 and refused redirects: `apps/gateway/src/ssrf.ts` + unit test + CI smoke. Default-deny NetworkPolicies with gateway-only ingress to upstreams and egress limited to what each pod needs: `charts/*/templates/networkpolicy.yaml`, allow/deny verified in CI. Non-root, read-only, capabilities dropped for our images. Upstream credentials AES-256-GCM at rest: `apps/gateway/src/crypto.ts`. No pod mounts a ServiceAccount token, so there is no RBAC to minimise until the multi-store bonus |
| **7. Scaling** | Partial | Stateless MCP endpoint, so any replica serves any request. All state in Postgres. Health poller leader-elected by an advisory lock, with handover in about 1 s on shutdown (`apps/gateway/src/upstream.ts`). Prod runs 2 replicas + PDB. **Not done:** per-key rate limits, and a CI run with 2 replicas |
| **9. Upgrades and rollback** | Partial | Expand-only migrations, `maxUnavailable: 0`, setup Job re-runs on upgrade with a pinned WooCommerce version + `wp wc update`. Commands in README. **Not done:** a recorded upgrade/rollback demo, and a pre-upgrade DB dump hook |
| **8. Observability** | Partial | Clear unreachable reasons (`ECONNREFUSED`, `timed out after Nms`) on the dashboard and in every audit row. JSON logs. **Not done:** Prometheus metrics |
| 1. VPS deployment | Instructions only | README "Production" + `values-prod.yaml`. Not yet deployed and shown |
| 2. Tool permissions | Not done | Designed in PLAN.md §5.1 (`tool_policies`) |
| 3. OAuth on the gateway | Not done | |
| 4. Handling many tools | Not done | Designed in PLAN.md §10 (search + call meta-tools) |
| 5. Hosted MCP servers | Not done | |
| Bonus: multi-store provisioning | Not done | `charts/store` is already per-release reusable. Design in PLAN.md §14 |

Also beyond the brief: **`scripts/dod.sh` walks the assignment's definition of done with curl** (two users, real LLM; 35/35 on a MacBook with k3d), and **CI runs the whole system on a real k3d cluster on every push** (`.github/workflows/ci.yml`, `scripts/smoke*.sh`). That covers about 50 end-to-end checks: a real COD order, MCP routing and collisions, timeout, disable, kill and recover, revoke, audit attribution, SSRF and NetworkPolicy.
