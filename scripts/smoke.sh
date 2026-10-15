#!/usr/bin/env bash
# End-to-end smoke test against a deployed release. Used by CI and handy locally.
set -uo pipefail
NS=${NS:-urumi}; REL=${REL:-urumi}; DOMAIN=${DOMAIN:-localtest.me}
STORE="http://store.$DOMAIN"
CI=${CI:-}
export SMOKE_LOG=${SMOKE_LOG:-$(mktemp)}
pass() { echo "  ✔ $*"; [ -z "$CI" ] || echo "PASS: $*" >> "${SMOKE_LOG:-/dev/null}"; }
fail() { echo "  ✘ $*"; [ -n "$CI" ] && echo "::error title=smoke::$*"; exit 1; }
secret() { kubectl -n "$NS" get secret "$REL-store" -o jsonpath="{.data.$1}" | base64 -d; }
pids=(); trap 'kill ${pids[@]} 2>/dev/null || true' EXIT
forward() {   # port-forward and wait until the local port answers (up to 30 s)
  kubectl -n "$NS" port-forward "svc/$1" "$2" >/dev/null 2>&1 & pids+=($!)
  for _ in $(seq 30); do curl -s -o /dev/null "http://127.0.0.1:${2%%:*}/" && return; sleep 1; done
  fail "port-forward to $1 never became ready"
}

echo "== storefront (waits up to 3 min for the ingress controller)"
for _ in $(seq 90); do code=$(curl -s -o /dev/null -w '%{http_code}' "$STORE/shop/"); [ "$code" = 200 ] && break; sleep 2; done
[ "$code" = 200 ] && pass "GET /shop/ -> 200" || fail "GET $STORE/shop/ -> $code"

echo "== place a COD order through the WooCommerce Store API (same path as the checkout page)"
jar=$(mktemp); hdr=$(mktemp)
pid=$(curl -s "$STORE/wp-json/wc/store/v1/products?search=Mug" | jq -r '.[0].id // empty')
[ -n "$pid" ] && pass "found product Urumi Mug (#$pid)" || fail "sample product missing"
curl -s -c "$jar" -D "$hdr" -o /dev/null "$STORE/wp-json/wc/store/v1/cart"
nonce=$(grep -i '^nonce:' "$hdr" | awk '{print $2}' | tr -d '\r')
api() { curl -s -b "$jar" -c "$jar" -H "Nonce: $nonce" -H 'Content-Type: application/json' -X POST "$STORE/wp-json/wc/store/v1/$1" -d "$2"; }
api cart/add-item "{\"id\":$pid,\"quantity\":1}" >/dev/null
order=$(api checkout '{"payment_method":"cod","billing_address":{"first_name":"Smoke","last_name":"Test","address_1":"1 Test St","city":"San Jose","state":"CA","postcode":"95112","country":"US","email":"smoke@example.com","phone":"5550100"}}')
oid=$(echo "$order" | jq -r '.order_id // empty' 2>/dev/null)
[ -n "$oid" ] && pass "checkout -> order #$oid ($(echo "$order" | jq -r .status))" || fail "checkout failed: ${order:0:300}"

echo "== order visible to the admin REST API (the path woo-mcp uses)"
forward "$REL-wordpress" 18080:80
status=$(curl -s -u "$(secret WC_CONSUMER_KEY):$(secret WC_CONSUMER_SECRET)" -H 'X-Forwarded-Proto: https' \
  "http://127.0.0.1:18080/wp-json/wc/v3/orders/$oid" | jq -r '.status // .code')
[ "$status" = processing ] && pass "GET /wc/v3/orders/$oid -> processing" || fail "admin API returned: $status"

echo "== the same Basic-auth call through the public Ingress must be refused (Traefik rewrites X-Forwarded-Proto)"
code=$(curl -s -o /dev/null -w '%{http_code}' -u "$(secret WC_CONSUMER_KEY):$(secret WC_CONSUMER_SECRET)" \
  -H 'X-Forwarded-Proto: https' "$STORE/wp-json/wc/v3/orders/$oid")
[ "$code" = 401 ] && pass "public Basic auth -> 401" || fail "public Basic auth -> $code (expected 401)"

echo "== woo-mcp over MCP Streamable HTTP"
forward "$REL-woo-mcp" 13000:3000
TOKEN=$(secret WOO_MCP_TOKEN)
mcp() { local params=${2:-'{}'}; curl -s -X POST http://127.0.0.1:13000/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$params}"; }
call() { mcp tools/call "{\"name\":\"$1\",\"arguments\":$2}" | jq -r '.result.content[0].text'; }

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:13000/mcp -d '{}')
[ "$code" = 401 ] && pass "no bearer -> 401" || fail "no bearer -> $code"
n=$(mcp tools/list | jq '.result.tools | length')
[ "$n" = 5 ] && pass "tools/list -> 5 tools" || fail "tools/list -> $n"
created=$(call create_product '{"name":"CI Mug","regular_price":"9.99"}')
newid=$(echo "$created" | jq -r '.id // empty' 2>/dev/null)
[ -n "$newid" ] && pass "create_product -> #$newid" || fail "create_product failed: ${created:0:300}"
link=$(echo "$created" | jq -r .permalink)
code=$(curl -s -o /dev/null -w '%{http_code}' "$link")
[ "$code" = 200 ] && pass "new product is on the storefront ($link)" || fail "GET $link -> $code"
call list_orders '{"period":"today"}' | jq -e --argjson o "$oid" 'any(.[]; .id == $o)' >/dev/null \
  && pass "list_orders(period=today) contains #$oid" || fail "today's orders missing #$oid"
s=$(call update_order_status "{\"id\":$oid,\"status\":\"completed\"}" | jq -r .status)
[ "$s" = completed ] && pass "update_order_status -> completed" || fail "update_order_status -> $s"

echo "== NetworkPolicy: only gateway pods can reach woo-mcp"
# k3s adds a new pod's IP to policy allow-lists a moment after it starts, so both probes
# give it a few seconds: the allowed one retries, the denied one only tries after settling.
probe() { kubectl -n "$NS" run "np-$1-$RANDOM" --rm -i --restart=Never --quiet --image=curlimages/curl:8.11.1 $2 \
  -- sh -c "sleep 5; for i in 1 2 3 4 5 6; do c=\$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://$REL-woo-mcp:3000/healthz); [ \"\$c\" = 200 ] && break; [ $1 = other ] && break; sleep 2; done; echo \$c" 2>/dev/null; }
r=$(probe other ""); [ "$r" != 200 ] && pass "random pod blocked ($r)" || fail "random pod reached woo-mcp"
r=$(probe gw "--labels=app.kubernetes.io/component=gateway"); [ "$r" = 200 ] && pass "gateway-labelled pod allowed" || fail "gateway pod blocked ($r)"

echo "== gateway"
kill ${pids[@]} 2>/dev/null || true
UT="kubectl -n $NS"
ADMIN_EMAIL=$(kubectl -n "$NS" get deploy "$REL-gateway" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="BOOTSTRAP_ADMIN_EMAIL")].value}') \
ADMIN_PASSWORD=$(kubectl -n "$NS" get secret "$REL-gateway" -o jsonpath='{.data.BOOTSTRAP_ADMIN_PASSWORD}' | base64 -d) \
GW="http://app.$DOMAIN" ORDER_ID="$oid" \
KILL_UTILS="$UT scale deploy $REL-utils-mcp --replicas=0 && $UT wait --for=delete pod -l app.kubernetes.io/component=utils-mcp --timeout=60s" \
REVIVE_UTILS="$UT scale deploy $REL-utils-mcp --replicas=1" \
  "$(dirname "$0")/smoke-gateway.sh" || exit 1

echo "ALL GOOD"
[ -n "$CI" ] && echo "::notice title=smoke passed::$(wc -l < "$SMOKE_LOG") checks: $(cut -c7- "$SMOKE_LOG" | cut -c1-60 | paste -sd ';' | sed 's/;/ | /g')"
