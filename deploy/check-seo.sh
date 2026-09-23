#!/bin/sh
# Public GET checks: run after deployment and cache purge.
set -eu
origin=https://rogernortconsult.com

check_status() {
  expected=$1
  url=$2
  actual=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "$url")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL $url: expected HTTP $expected, got $actual" >&2
    exit 1
  fi
  echo "OK $url: HTTP $actual"
}

for path in / /dubai-holiday-packages-from-accra.html /visa-assistance-accra.html /czech-republic-work-abroad-ghana.html /privacy-policy.html /terms.html /robots.txt /sitemap.xml; do
  check_status 200 "$origin$path"
done

# Unique path avoids reusing a cached response from before the routing fix.
check_status 404 "$origin/seo-missing-page-$(date +%s)-$$"

for url in http://rogernortconsult.com/ http://www.rogernortconsult.com/ https://www.rogernortconsult.com/; do
  result=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code} %{redirect_url}' "$url")
  case "$result" in
    "301 $origin/"|"308 $origin/") echo "OK $url: $result" ;;
    *) echo "FAIL $url: unexpected redirect $result" >&2; exit 1 ;;
  esac
done
