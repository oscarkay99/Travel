#!/bin/sh
set -eu

: "${CLOUDFLARE_API_TOKEN:?Cloudflare API token is required}"
: "${CLOUDFLARE_ZONE_ID:?Cloudflare zone ID is required}"

NGINX_CONF=/etc/nginx/sites-enabled/rogernort-www
BACKUP_DIR=/etc/nginx/rogernort-backups
AOP_DIR=/opt/rogernort/aop
CA_CERT=/etc/nginx/certs/rogernort-aop-ca.pem

for command_name in curl jq openssl nginx systemctl awk; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name"
    exit 1
  }
done

if [ ! -f "$NGINX_CONF" ] \
  || ! grep -Eq 'server_name[[:space:]]+rogernortconsult\.com' "$NGINX_CONF" \
  || ! grep -Eq 'root[[:space:]]+/opt/rogernort/nginx/html;' "$NGINX_CONF"; then
  echo "Rogernort Nginx configuration failed its identity checks."
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$AOP_DIR" /etc/nginx/certs
chmod 700 "$BACKUP_DIR" "$AOP_DIR"
cp "$NGINX_CONF" "$BACKUP_DIR/rogernort-www.pre-aop"

apply_client_mode() {
  mode="$1"
  awk -v mode="$mode" '
    /# BEGIN ROGERNORT MANAGED AOP/ { skip = 1; next }
    skip && /# END ROGERNORT MANAGED AOP/ { skip = 0; next }
    skip { next }
    {
      print
      if ($0 ~ /^[[:space:]]*server[[:space:]]*\{/) inserted = 0
      if (!inserted && $0 ~ /^[[:space:]]*listen[[:space:]].*443/) {
        print "    # BEGIN ROGERNORT MANAGED AOP"
        print "    ssl_client_certificate /etc/nginx/certs/rogernort-aop-ca.pem;"
        print "    ssl_verify_client " mode ";"
        print "    # END ROGERNORT MANAGED AOP"
        inserted = 1
      }
    }
  ' "$NGINX_CONF" > /tmp/rogernort-aop-nginx.conf
  cat /tmp/rogernort-aop-nginx.conf > "$NGINX_CONF"
  rm /tmp/rogernort-aop-nginx.conf
}

rollback_nginx() {
  cp "$BACKUP_DIR/rogernort-www.pre-aop" "$NGINX_CONF"
  nginx -t
  systemctl reload nginx
}

if [ ! -s "$AOP_DIR/ca.pem" ] || [ ! -s "$AOP_DIR/client.pem" ] || [ ! -s "$AOP_DIR/client.key" ]; then
  umask 077
  openssl genrsa -out "$AOP_DIR/ca.key" 3072 >/dev/null 2>&1
  openssl req -x509 -new -sha256 -days 3650 \
    -key "$AOP_DIR/ca.key" \
    -subj '/CN=Rogernort Cloudflare AOP CA' \
    -out "$AOP_DIR/ca.pem"
  openssl genrsa -out "$AOP_DIR/client.key" 3072 >/dev/null 2>&1
  openssl req -new -sha256 \
    -key "$AOP_DIR/client.key" \
    -subj '/CN=cloudflare-origin-pull.rogernortconsult.com' \
    -out "$AOP_DIR/client.csr"
  cat > "$AOP_DIR/client.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
subjectAltName=DNS:cloudflare-origin-pull.rogernortconsult.com
EOF
  openssl x509 -req -sha256 -days 825 \
    -in "$AOP_DIR/client.csr" \
    -CA "$AOP_DIR/ca.pem" \
    -CAkey "$AOP_DIR/ca.key" \
    -CAcreateserial \
    -extfile "$AOP_DIR/client.ext" \
    -out "$AOP_DIR/client.pem" >/dev/null 2>&1
  chmod 600 "$AOP_DIR"/*.key "$AOP_DIR"/*.pem
fi

cp "$AOP_DIR/ca.pem" "$CA_CERT"
chmod 644 "$CA_CERT"

# Accept both authenticated and unauthenticated clients until Cloudflare has
# deployed the hostname association. This prevents an origin lockout.
apply_client_mode optional
if ! nginx -t; then
  rollback_nginx
  echo "Optional AOP Nginx configuration failed and was rolled back."
  exit 1
fi
systemctl reload nginx

CERT_ID=""
if [ -s "$AOP_DIR/cert_id" ]; then
  CERT_ID=$(tr -cd 'A-Za-z0-9-' < "$AOP_DIR/cert_id")
fi

if [ -z "$CERT_ID" ]; then
  umask 077
  jq -n --rawfile certificate "$AOP_DIR/client.pem" --rawfile private_key "$AOP_DIR/client.key" \
    '{certificate:$certificate,private_key:$private_key}' > /tmp/rogernort-aop-upload.json
  UPLOAD_HTTP=$(curl -sS -o /tmp/rogernort-aop-response.json -w '%{http_code}' \
    -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/origin_tls_client_auth/hostnames/certificates" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary @/tmp/rogernort-aop-upload.json)
  rm /tmp/rogernort-aop-upload.json
  if [ "$UPLOAD_HTTP" -lt 200 ] || [ "$UPLOAD_HTTP" -ge 300 ]; then
    rm -f /tmp/rogernort-aop-response.json
    rollback_nginx
    echo "Cloudflare rejected the AOP certificate upload (HTTP $UPLOAD_HTTP)."
    exit 1
  fi
  CERT_ID=$(jq -r '.result.id // empty' /tmp/rogernort-aop-response.json)
  rm /tmp/rogernort-aop-response.json
  if ! printf '%s' "$CERT_ID" | grep -Eq '^[A-Za-z0-9-]{8,64}$'; then
    rollback_nginx
    echo "Cloudflare did not return a valid AOP certificate ID."
    exit 1
  fi
  printf '%s\n' "$CERT_ID" > "$AOP_DIR/cert_id"
  chmod 600 "$AOP_DIR/cert_id"
fi

jq -n --arg cert_id "$CERT_ID" '{config:[
  {hostname:"rogernortconsult.com",cert_id:$cert_id,enabled:true},
  {hostname:"www.rogernortconsult.com",cert_id:$cert_id,enabled:true}
]}' > /tmp/rogernort-aop-association.json
ASSOC_HTTP=$(curl -sS -o /tmp/rogernort-aop-association-response.json -w '%{http_code}' \
  -X PUT "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/origin_tls_client_auth/hostnames" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/rogernort-aop-association.json)
rm /tmp/rogernort-aop-association.json /tmp/rogernort-aop-association-response.json
if [ "$ASSOC_HTTP" -lt 200 ] || [ "$ASSOC_HTTP" -ge 300 ]; then
  rollback_nginx
  echo "Cloudflare rejected the AOP hostname association (HTTP $ASSOC_HTTP)."
  exit 1
fi

ASSOCIATION_ACTIVE=false
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  STATUS_HTTP=$(curl -sS -o /tmp/rogernort-aop-status.json -w '%{http_code}' \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/origin_tls_client_auth/hostnames/rogernortconsult.com" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
  if [ "$STATUS_HTTP" = 200 ] \
    && [ "$(jq -r '.result.enabled // false' /tmp/rogernort-aop-status.json)" = true ] \
    && [ "$(jq -r '.result.cert_status // .result.status // empty' /tmp/rogernort-aop-status.json)" = active ]; then
    ASSOCIATION_ACTIVE=true
    break
  fi
  sleep 5
done
rm -f /tmp/rogernort-aop-status.json
if [ "$ASSOCIATION_ACTIVE" != true ]; then
  rollback_nginx
  echo "Cloudflare AOP association did not become active in time."
  exit 1
fi

apply_client_mode on
if ! nginx -t; then
  rollback_nginx
  echo "Required AOP Nginx configuration failed and was rolled back."
  exit 1
fi
systemctl reload nginx

PUBLIC_OK=false
for attempt in 1 2 3 4 5 6; do
  if curl -fsS --max-time 15 https://rogernortconsult.com/api/agent/status \
    | grep -q '"ok":true'; then
    PUBLIC_OK=true
    break
  fi
  sleep 5
done
if [ "$PUBLIC_OK" != true ]; then
  apply_client_mode optional
  nginx -t
  systemctl reload nginx
  echo "Public Cloudflare traffic failed AOP validation; origin enforcement was relaxed."
  exit 1
fi

DIRECT_STATUS=$(curl -sS --max-time 10 \
  --resolve rogernortconsult.com:443:127.0.0.1 \
  -o /dev/null -w '%{http_code}' https://rogernortconsult.com/ || true)
case "$DIRECT_STATUS" in
  200|301|302)
    apply_client_mode optional
    nginx -t
    systemctl reload nginx
    echo "Direct origin request was not rejected; origin enforcement was relaxed."
    exit 1
    ;;
esac

echo "Authenticated Origin Pulls are active and direct origin access is rejected."
