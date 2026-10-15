#!/usr/bin/env bash
# Gateway end-to-end: the definition-of-done flows minus the browser and the LLM.
# Env: GW (base URL), ADMIN_EMAIL, ADMIN_PASSWORD, KILL_UTILS / REVIVE_UTILS (shell commands),
#      ORDER_ID (optional: an order placed today that list_orders must return).
set -uo pipefail
GW=${GW:-http://app.localtest.me}
CI=${CI:-}
pass() { echo "  ✔ $*"; [ -z "$CI" ] || echo "PASS: $*" >> "${SMOKE_LOG:-/dev/null}"; }
fail() { echo "  ✘ $*"; [ -n "$CI" ] && echo "::error title=smoke-gateway::$*"; exit 1; }
tmp=$(mktemp -d); A=$tmp/admin; M=$tmp/member
BEMAIL="b-$(date +%s)-$RANDOM@example.com"   # unique, so the script can be re-run on the same cluster

rest() { local jar=$1 method=$2 path=$3; shift 3; curl -s -b "$jar" -c "$jar" -X "$method" -H 'Content-Type: application/json' "$GW/api$path" "$@"; }
mcp() { local key=$1 method=$2 params=${3:-'{}'}; curl -s -X POST "$GW/mcp" -H "Authorization: Bearer $key" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"; }
call() { mcp "$1" tools/call "{\"name\":\"$2\",\"arguments\":${3:-'{}'}}"; }
tools() { mcp "$1" tools/list | jq -r '.result.tools[].name'; }
server_id() { rest "$A" GET /servers | jq -r --arg s "$1" '.[] | select(.slug == $s) | .id'; }
wait_status() { for _ in $(seq 40); do st=$(rest "$A" GET /servers | jq -r --arg s "$1" '.[] | select(.slug == $s) | .status'); [ "$st" = "$2" ] && return 0; sleep 2; done; return 1; }

echo "== gateway up"
for _ in $(seq 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$GW/readyz")" = 200 ] && break; sleep 2; done
[ "$(curl -s "$GW/readyz")" = ok ] && pass "/readyz" || fail "gateway not ready at $GW"

echo "== admin: login, three servers connected"
login=$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')   # no \" inside "$(...)": macOS bash 3.2 mis-parses it
[ "$(rest "$A" POST /auth/login -d "$login" | jq -r .ok)" = true ] && pass "admin login" || fail "admin login"
for s in woo utils everything; do wait_status "$s" connected && pass "$s connected" || fail "$s is $(rest "$A" GET /servers | jq -c --arg s "$s" '.[]|select(.slug==$s)|{status,lastError}')"; done
rest "$A" GET /servers | grep -q '"credential' && fail "API leaked a credential field" || pass "no credential values in /api/servers"

echo "== SSRF guard on admin-supplied URLs"
for u in http://169.254.169.254/latest/meta-data http://10.0.0.5/mcp http://localhost:5432/; do
  code=$(rest "$A" POST /servers -o /dev/null -w '%{http_code}' -d "{\"slug\":\"evil\",\"name\":\"evil\",\"url\":\"$u\"}")
  [ "$code" = 400 ] && pass "rejected $u" || fail "SSRF: $u -> $code"
done

echo "== invite member B, B creates an API key"
token=$(rest "$A" POST /invites -d "{\"email\":\"$BEMAIL\",\"role\":\"member\"}" | jq -r .token)
[ "$(rest "$M" POST "/invites/$token/accept" -d '{"name":"User B","password":"memberpass123"}' | jq -r .ok)" = true ] && pass "invite accepted" || fail "invite accept"
KEY=$(rest "$M" POST /keys -d '{"name":"claude-code"}' | jq -r .key)
[[ "$KEY" == mcpgw_* ]] && pass "member key issued" || fail "key creation"
code=$(rest "$M" POST /servers -o /dev/null -w '%{http_code}' -d '{"slug":"x","name":"x","url":"http://example.com/mcp"}')
[ "$code" = 403 ] && pass "member can't add servers (403)" || fail "member add server -> $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/mcp" -d '{}')
[ "$code" = 401 ] && pass "/mcp without key -> 401" || fail "/mcp without key -> $code"

echo "== B over MCP: aggregated tools, routing, collisions"
list=$(tools "$KEY")
for t in woo__list_orders woo__create_product utils__convert_currency utils__echo everything__echo; do
  grep -qx "$t" <<<"$list" || fail "tools/list missing $t"; done
pass "tools/list: $(wc -l <<<"$list") tools from 3 servers, incl. utils__echo + everything__echo"
r=$(call "$KEY" utils__echo '{"message":"hi"}' | jq -r '.result.content[0].text'); [[ "$r" == "utils echo: hi" ]] && pass "utils__echo routed to utils" || fail "utils__echo -> $r"
r=$(call "$KEY" everything__echo '{"message":"hi"}' | jq -r '.result.content[0].text'); [[ "$r" == *hi* && "$r" != utils* ]] && pass "everything__echo routed to everything" || fail "everything__echo -> $r"
orders=$(call "$KEY" woo__list_orders '{"period":"today"}' | jq -r '.result.content[0].text')
if [ -n "${ORDER_ID:-}" ]; then jq -e --argjson o "$ORDER_ID" 'any(.[]; .id == $o)' <<<"$orders" >/dev/null && pass "woo__list_orders(today) has #$ORDER_ID" || fail "orders: ${orders:0:200}"
else jq -e 'type == "array"' <<<"$orders" >/dev/null && pass "woo__list_orders(today) -> $(jq length <<<"$orders") orders" || fail "orders: ${orders:0:200}"; fi
r=$(call "$KEY" utils__convert_currency '{"amount":100,"from":"USD","to":"EUR"}' | jq -r '.result.content[0].text' | jq -r .result)
[ "$r" = 92 ] && pass "utils__convert_currency 100 USD -> 92 EUR" || fail "convert -> $r"

echo "== timeout: per-server timeout returns a clear error"
uid=$(server_id utils)
rest "$A" PATCH "/servers/$uid" -d '{"timeoutMs":2000}' >/dev/null
r=$(call "$KEY" utils__sleep '{"seconds":5}' | jq -c '.result')
[[ "$(jq -r .isError <<<"$r")" == true && "$r" == *"timed out after 2000ms"* ]] && pass "utils__sleep(5) with 2s timeout -> timed out" || fail "timeout -> $r"
rest "$A" PATCH "/servers/$uid" -d '{"timeoutMs":15000}' >/dev/null

echo "== disable 'everything': its tools disappear and calls are denied"
eid=$(server_id everything)
rest "$A" PATCH "/servers/$eid" -d '{"enabled":false}' >/dev/null
tools "$KEY" | grep -q '^everything__' && fail "disabled server still listed" || pass "everything__* gone from tools/list"
r=$(call "$KEY" everything__echo '{"message":"x"}' | jq -r '.result.content[0].text'); [[ "$r" == *disabled* ]] && pass "call to disabled server denied" || fail "disabled call -> $r"

echo "== kill utils: others keep working, dashboard shows unreachable"
eval "$KILL_UTILS"
r=$(call "$KEY" utils__now '{}' | jq -r '.result.content[0].text'); [[ "$r" == *unreachable* ]] && pass "utils call -> clear error: ${r:0:90}" || fail "dead upstream -> $r"
wait_status utils unreachable && pass "utils status: unreachable ($(rest "$A" GET /servers | jq -r '.[]|select(.slug=="utils")|.lastError' | cut -c1-70))" || fail "utils not marked unreachable"
tools "$KEY" | grep -q '^utils__' && fail "dead server still listed" || pass "utils__* gone from tools/list"
call "$KEY" woo__list_products '{"per_page":1}' | jq -e '.result.isError != true' >/dev/null && pass "woo still works" || fail "woo broke while utils was down"
eval "$REVIVE_UTILS"
wait_status utils connected && pass "utils recovered on its own" || fail "utils did not recover"

echo "== dashboard and chat agent"
curl -s "$GW/" | grep -q '<title>Urumi MCP Gateway</title>' && pass "dashboard served at /" || fail "dashboard not served"
code=$(curl -s -o /dev/null -w '%{http_code}' "$GW/invite/some-token"); [ "$code" = 200 ] && pass "SPA fallback for /invite/<token>" || fail "SPA fallback -> $code"
r=$(rest "$M" POST /chat -d '{"messages":[{"role":"user","content":"What orders came in today?"}]}')
if jq -e '.reply' <<<"$r" >/dev/null; then pass "chat replied with $(jq '.toolCalls | length' <<<"$r") tool call(s)"
elif [ "$(jq -r .error.code <<<"$r")" = llm_error ]; then pass "chat endpoint up; LLM not usable here: $(jq -r .error.message <<<"$r" | cut -c1-60)"
else fail "chat -> ${r:0:200}"; fi

echo "== revoke B's key: next call rejected"
kid=$(rest "$M" GET /keys | jq -r '.[0].id')
code=$(rest "$M" DELETE "/keys/$kid" -o /dev/null -w '%{http_code}'); [ "$code" = 204 ] && pass "key revoked" || fail "revoke -> $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/mcp" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"woo__list_orders","arguments":{}}}')
[ "$code" = 401 ] && pass "revoked key -> 401" || fail "revoked key -> $code"

echo "== audit log: every call above, attributed to B"
audit=$(rest "$A" GET "/audit?limit=200")
outcomes=$(jq -r --arg b "$BEMAIL" '[.[] | select(.user_email == $b) | .outcome] | unique | join(",")' <<<"$audit")
for o in ok denied timeout unreachable; do [[ ",$outcomes," == *",$o,"* ]] || fail "audit missing outcome '$o' for B (have: $outcomes)"; done
pass "B's audit rows cover: $outcomes"
jq -e --arg b "$BEMAIL" 'any(.[]; .user_email == $b and .outcome == "denied" and .error == "API key revoked")' <<<"$audit" >/dev/null \
  && pass "revoked-key attempt audited under B" || fail "revoked attempt not audited"
mine=$(rest "$M" GET /audit | jq -r '[.[].user_email] | unique | join(",")')
[ "$mine" = "$BEMAIL" ] && pass "member sees only own audit rows" || fail "member audit scope: $mine"

rest "$A" PATCH "/servers/$eid" -d '{"enabled":true}' >/dev/null
echo "GATEWAY OK"
