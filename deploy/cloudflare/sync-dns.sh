#!/usr/bin/env bash
# Point docwriter.org DNS at Vercel. Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.
set -euo pipefail

ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
APEX_IP="${VERCEL_APEX_IP:-76.76.21.21}"
WWW_CNAME="${VERCEL_CNAME:-cname.vercel-dns.com}"
API="https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records"

if [[ -z "$ZONE_ID" || -z "$TOKEN" ]]; then
	echo "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID (see deploy/cloudflare/README.md)"
	exit 1
fi

api() {
	local method="$1"
	local body="${2:-}"
	if [[ -n "$body" ]]; then
		curl -sfS -X "$method" "$API" \
			-H "Authorization: Bearer ${TOKEN}" \
			-H "Content-Type: application/json" \
			-d "$body"
	else
		curl -sfS -X "$method" "$API" \
			-H "Authorization: Bearer ${TOKEN}" \
			-H "Content-Type: application/json"
	fi
}

find_record_id() {
	local type="$1"
	local name="$2"
	api GET | jq -r --arg t "$type" --arg n "$name" \
		'.result[] | select(.type == $t and .name == $n) | .id' | head -1
}

upsert() {
	local type="$1"
	local name="$2"
	local content="$3"
	local proxied="${4:-false}"
	local id
	id="$(find_record_id "$type" "$name")"
	local payload
	payload="$(jq -n --arg type "$type" --arg name "$name" --arg content "$content" --argjson proxied "$proxied" \
		'{type: $type, name: $name, content: $content, proxied: $proxied}')"
	if [[ -n "$id" ]]; then
		curl -sfS -X PUT "${API}/${id}" \
			-H "Authorization: Bearer ${TOKEN}" \
			-H "Content-Type: application/json" \
			-d "$payload"
	else
		curl -sfS -X POST "$API" \
			-H "Authorization: Bearer ${TOKEN}" \
			-H "Content-Type: application/json" \
			-d "$payload"
	fi
	echo "upserted ${type} ${name} → ${content}"
}

upsert A "docwriter.org" "$APEX_IP" false
upsert CNAME "www.docwriter.org" "$WWW_CNAME" false

echo "Done. Verify in Cloudflare DNS and Vercel → Settings → Domains."
