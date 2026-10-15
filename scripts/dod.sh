#!/usr/bin/env bash
# Definition-of-done walkthrough with curl, against the running cluster and the REAL LLM.
# Follows the assignment's DoD section step by step, with two users (A = admin, B = member).
# Safe to re-run: unique product/user names per run; anything it disables is restored.
# Needs: kubectl (pointing at the cluster), curl, jq. Usage: scripts/dod.sh
set -uo pipefail
NS=${NS:-urumi}; REL=${REL:-urumi}; DOMAIN=${DOMAIN:-localtest.me}
STORE=${STORE:-http://store.$DOMAIN}; GW=${GW:-http://app.$DOMAIN}
RUN=$(date +%s); PRODUCT="Demo Mug $RUN"; BEMAIL="user-b-$RUN@example.com"
tmp=$(mktemp -d); A=$tmp/a; B=$tmp/b; SHOP=$tmp/shop
passed=0; warned=0

pass() { echo "  ✔ $*"; passed=$((passed + 1)); }
soft() { echo "  ⚠ $*"; warned=$((warned + 1)); }   # LLM wording varies: reported, not fatal
step() { echo; echo "== $*"; }
cleanup() {
  [ -n "${EID:-}" ] && rest "$A" PATCH "/servers/$EID" -d '{"enabled":true}' >/dev/null 2>&1
  [ -n "${SCALED:-}" ] && kubectl -n "$NS" scale deploy "$REL-utils-mcp" --replicas=1 >/dev/null 2>&1
  rm -rf "$tmp"
}
fail() { echo "  ✘ $*"; echo; echo "FAILED. Fix the step above and re-run."; cleanup; exit 1; }
trap cleanup EXIT

rest() { local jar=$1 method=$2 path=$3; shift 3
  curl -s -m 30 -b "$jar" -c "$jar" -X "$method" -H 'Content-Type: application/json' "$GW/api$path" "$@"; }
mcp() { local key=$1 method=$2 params=${3:-'{}'}
  curl -s -m 60 -X POST "$GW/mcp" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"; }
mcp_code() { curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$GW/mcp" -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"woo__list_orders","arguments":{}}}'; }
call() { mcp "$1" tools/call "{\"name\":\"$2\",\"arguments\":${3:-'{}'}}" | jq -r '.result.content[0].text // .error.message // "no result"'; }
tools() { mcp "$1" tools/list | jq -r '.result.tools[].name'; }
# chat <jar> <prompt>: prints the LLM reply + tool trace, leaves JSON in $CHAT
chat() {
  local body; body=$(jq -n --arg p "$2" '{messages:[{role:"user",content:$p}]}')
  CHAT=$(curl -s -m 180 -b "$1" -H 'Content-Type: application/json' "$GW/api/chat" -d "$body")
  if jq -e '.error' <<<"$CHAT" >/dev/null; then fail "chat error: $(jq -r .error.message <<<"$CHAT" | cut -c1-300)"; fi
  echo "     you: $2"
  jq -r '.toolCalls[] | "     🔧 \(.name) \(.args|tostring|.[0:80])\(if .isError then "  ERROR" else "" end)"' <<<"$CHAT"
  echo "     llm: $(jq -r .reply <<<"$CHAT" | tr '\n' ' ' | cut -c1-300)"
}
chat_used() { jq -e --arg t "$1" 'any(.toolCalls[]; .name == $t and (.isError | not))' <<<"$CHAT" >/dev/null; }
server_field() { rest "$A" GET /servers | jq -r --arg s "$1" --arg f "$2" '.[] | select(.slug == $s) | .[$f]'; }

step "0. Preconditions"
kubectl -n "$NS" get deploy "$REL-gateway" >/dev/null 2>&1 || fail "kubectl can't reach the cluster (k3d cluster start urumi?)"
[ "$(curl -s -m 10 "$GW/readyz")" = ok ] && pass "gateway ready at $GW" || fail "gateway not ready at $GW"
klen=$(kubectl -n "$NS" get secret "$REL-gateway" -o jsonpath='{.data.LLM_API_KEY}' | base64 -d | wc -c | tr -d ' ')
[ "$klen" -gt 0 ] && pass "LLM key present ($(kubectl -n "$NS" get deploy "$REL-gateway" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LLM_MODEL")].value}'))" || fail "no LLM key in Secret $REL-gateway"
APW=$(kubectl -n "$NS" get secret "$REL-gateway" -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d)
AEMAIL=$(kubectl -n "$NS" get deploy "$REL-gateway" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="BOOTSTRAP_ADMIN_EMAIL")].value}')

step "1. Store: storefront is up"
code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$STORE/shop/")
[ "$code" = 200 ] && pass "GET $STORE/shop/ -> 200" || fail "storefront -> $code"

step "2. User A (admin) logs in"
login=$(jq -n --arg e "$AEMAIL" --arg p "$APW" '{email:$e,password:$p}')   # no \" inside "$(...)": macOS bash 3.2 mis-parses it
[ "$(rest "$A" POST /auth/login -d "$login" | jq -r .ok)" = true ] && pass "logged in as $AEMAIL" || fail "admin login"
AKEY=$(rest "$A" POST /keys -d "{\"name\":\"dod-$RUN\"}" | jq -r .key)
[[ "$AKEY" == mcpgw_* ]] && pass "admin API key for verification calls" || fail "admin key"
for s in woo utils everything; do st=$(server_field "$s" status); [ "$st" = connected ] && pass "server $s: connected" || fail "server $s: $st ($(server_field "$s" lastError))"; done

step "3. Chat as A: create a product with a name and price; it appears on the storefront"
chat "$A" "Create a product called \"$PRODUCT\" priced 12.50 and publish it."
chat_used woo__create_product && pass "agent called woo__create_product" || fail "agent did not create the product"
prod=$(curl -s -m 30 "$STORE/wp-json/wc/store/v1/products?search=$RUN" | jq -c '.[0] // empty')
[ -n "$prod" ] || fail "product '$PRODUCT' not found on the storefront"
PID=$(jq -r .id <<<"$prod"); price=$(jq -r .prices.price <<<"$prod"); link=$(jq -r .permalink <<<"$prod")
[ "$price" = 1250 ] && pass "on storefront: #$PID '$(jq -r .name <<<"$prod")' at 12.50" || soft "product found but price is $price (minor units), expected 1250"
[ "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$link")" = 200 ] && pass "product page loads: $link" || soft "product page $link did not return 200"

step "4. Shopper: add it to the cart and check out with Cash on delivery"
hdr=$tmp/h
curl -s -m 30 -c "$SHOP" -D "$hdr" -o /dev/null "$STORE/wp-json/wc/store/v1/cart"
nonce=$(grep -i '^nonce:' "$hdr" | awk '{print $2}' | tr -d '\r')
shop() { curl -s -m 60 -b "$SHOP" -c "$SHOP" -H "Nonce: $nonce" -H 'Content-Type: application/json' -X POST "$STORE/wp-json/wc/store/v1/$1" -d "$2"; }
shop cart/add-item "{\"id\":$PID,\"quantity\":1}" >/dev/null
order=$(shop checkout '{"payment_method":"cod","billing_address":{"first_name":"Dee","last_name":"Oh","address_1":"1 Demo St","city":"San Jose","state":"CA","postcode":"95112","country":"US","email":"shopper@example.com","phone":"5550100"}}')
OID=$(jq -r '.order_id // empty' <<<"$order" 2>/dev/null)
[ -n "$OID" ] && pass "order #$OID placed ($(jq -r .status <<<"$order"), COD)" || fail "checkout failed: $(echo "$order" | cut -c1-300)"
got=$(call "$AKEY" woo__get_order "{\"id\":$OID}")
jq -e --arg p "$PRODUCT" 'any(.items[]; .name == $p)' <<<"$got" >/dev/null && pass "order #$OID visible to the store admin API with '$PRODUCT'" || fail "order lookup: $(echo "$got" | cut -c1-200)"

step "5. Chat as A: what orders came in today? (should return that order)"
chat "$A" "What orders came in today? List their IDs and totals."
chat_used woo__list_orders && pass "agent called woo__list_orders" || fail "agent did not list orders"
jq -r .reply <<<"$CHAT" | grep -q "$OID" && pass "reply mentions order #$OID" || soft "reply didn't mention #$OID (check the wording above)"

step "6. Invite user B (member); B creates their own API key"
token=$(rest "$A" POST /invites -d "{\"email\":\"$BEMAIL\",\"role\":\"member\"}" | jq -r .token)
[ "$(rest "$B" POST "/invites/$token/accept" -d '{"name":"User B","password":"memberpass123"}' | jq -r .ok)" = true ] && pass "B joined as $BEMAIL" || fail "invite accept"
BKEY=$(rest "$B" POST /keys -d '{"name":"claude-code"}' | jq -r .key)
[[ "$BKEY" == mcpgw_* ]] && pass "B's key ${BKEY:0:15}…" || fail "B key"
code=$(rest "$B" POST /servers -o /dev/null -w '%{http_code}' -d '{"slug":"x","name":"x","url":"https://example.com/mcp"}')
[ "$code" = 403 ] && pass "B (member) can't add servers -> 403" || fail "member add server -> $code"
rest "$B" GET /servers | grep -q '"url"' && fail "member can see upstream URLs/credentials" || pass "B sees no upstream URLs or credentials"

step "7. External client as B: gateway URL + B's key only (what Claude Code/Cursor/Inspector do)"
init=$(mcp "$BKEY" initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}' | jq -r .result.serverInfo.name)
[ "$init" = urumi-gateway ] && pass "initialize -> $init" || fail "initialize: $init"
list=$(tools "$BKEY")
pass "tools/list: $(echo "$list" | wc -l | tr -d ' ') tools ($(echo "$list" | sed 's/__.*//' | sort | uniq -c | awk '{printf "%s %s, ", $2, $1}' | sed 's/, $//'))"
for t in woo__list_orders utils__convert_currency everything__echo; do echo "$list" | grep -qx "$t" || fail "missing $t"; done
call "$BKEY" woo__list_orders '{"period":"today"}' | jq -e --argjson o "$OID" 'any(.[]; .id == $o)' >/dev/null \
  && pass "B: woo__list_orders(today) returns #$OID" || fail "B: today's orders missing #$OID"
echo "     two different upstream servers in one prompt (B, via the chat agent):"
chat "$B" "What is the total value of today's orders, converted to EUR? Use the tools."
if chat_used woo__list_orders && jq -e 'any(.toolCalls[]; (.name | startswith("utils__")) and (.isError | not))' <<<"$CHAT" >/dev/null; then
  pass "one prompt used woo + utils"
else soft "the model didn't call both servers this time (LLM choice); re-run or rephrase"; fi

step "8. Revoke B's key: the next call is rejected"
kid=$(rest "$B" GET /keys | jq -r '.[0].id')
[ "$(rest "$A" DELETE "/keys/$kid" -o /dev/null -w '%{http_code}')" = 204 ] && pass "admin revoked B's key" || fail "revoke"
code=$(mcp_code "$BKEY"); [ "$code" = 401 ] && pass "B's next call -> 401" || fail "revoked key -> $code"

step "9. Disable 'everything': its tools disappear from the external client and the chat agent"
EID=$(server_field everything id)
rest "$A" PATCH "/servers/$EID" -d '{"enabled":false}' >/dev/null
tools "$AKEY" | grep -q '^everything__' && fail "still listed over MCP" || pass "everything__* gone from tools/list"
r=$(call "$AKEY" everything__echo '{"message":"hi"}'); [[ "$r" == *disabled* ]] && pass "direct call denied: $r" || fail "disabled call -> $r"
chat "$A" "Use the everything__echo tool to echo 'hi'. If you don't have that tool, say so."
jq -e 'any(.toolCalls[]; (.name | startswith("everything__")) and (.isError | not))' <<<"$CHAT" >/dev/null \
  && fail "chat still reached the disabled server" || pass "chat agent can't use everything__* tools"
rest "$A" PATCH "/servers/$EID" -d '{"enabled":true}' >/dev/null; EID=""; pass "re-enabled 'everything'"

step "10. Kill the utils upstream: others keep working, dashboard shows it unreachable"
kubectl -n "$NS" scale deploy "$REL-utils-mcp" --replicas=0 >/dev/null; SCALED=1   # scale to 0 so it stays dead long enough to observe
kubectl -n "$NS" wait --for=delete pod -l app.kubernetes.io/component=utils-mcp --timeout=60s >/dev/null 2>&1
r=$(call "$AKEY" utils__now '{}'); [[ "$r" == *unreachable* || "$r" == *timed\ out* ]] && pass "utils call -> clear error: ${r:0:90}" || fail "dead upstream -> $r"
for _ in $(seq 20); do [ "$(server_field utils status)" = unreachable ] && break; sleep 2; done
[ "$(server_field utils status)" = unreachable ] && pass "dashboard status: unreachable ($(server_field utils lastError | cut -c1-70))" || fail "utils not shown as unreachable"
call "$AKEY" woo__list_products '{"per_page":1}' | jq -e 'type == "array"' >/dev/null && pass "woo keeps working" || fail "woo broke while utils was down"
kubectl -n "$NS" scale deploy "$REL-utils-mcp" --replicas=1 >/dev/null; SCALED=""
for _ in $(seq 45); do [ "$(server_field utils status)" = connected ] && break; sleep 2; done
[ "$(server_field utils status)" = connected ] && pass "utils back and connected" || soft "utils not reconnected yet (poller runs every 10 s)"

step "11. Audit log: every call above, attributed to the right user"
audit=$(rest "$A" GET "/audit?limit=500")
an=$(jq --arg u "$AEMAIL" '[.[] | select(.user_email == $u and .source == "chat")] | length' <<<"$audit")
[ "$an" -gt 0 ] && pass "A: $an chat tool calls audited" || fail "no chat calls for A"
bo=$(jq -r --arg u "$BEMAIL" '[.[] | select(.user_email == $u) | "\(.source)/\(.outcome)"] | unique | join(", ")' <<<"$audit")
for want in mcp/ok mcp/denied chat/ok; do [[ ", $bo," == *", $want,"* ]] || fail "B audit missing $want (have: $bo)"; done
pass "B: $bo (incl. the revoked-key attempt)"
echo "     latest entries:"
jq -r '.[0:12][] | "     \(.at[11:19])  \(.user_email | .[0:28])  \(.source)  \(.server_slug // "-")·\(.tool_name)  \(.duration_ms)ms  \(.outcome)"' <<<"$audit"

echo
echo "DONE: $passed checks passed, $warned warnings (warnings = LLM wording, not failures)."
echo "Dashboard: $GW   (admin: $AEMAIL, password: make admin-password)"
