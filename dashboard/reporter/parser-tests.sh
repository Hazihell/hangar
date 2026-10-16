#!/bin/bash
# Hand-written fixtures from real macOS output formats; runs on macOS and GNU/Linux.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/mac-reporter.sh"
FAILS=0
pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; FAILS=1; }
[ "$(parse_cpu < "$DIR/fixtures/top.txt")" = 20.75 ] && pass "CPU uses second interval" || fail CPU
[ "$(parse_ram < "$DIR/fixtures/vm_stat.txt")" = 7208960000 ] && pass "Memory Used includes compressor, excludes purgeable" || fail RAM
[ "$(parse_disk < "$DIR/fixtures/df.txt")" = '306479976448 494384795648' ] && pass "APFS used is container total minus available" || fail disk
if printf 'bad output\n' | parse_ram; then fail "bad RAM accepted"; else pass "bad RAM rejected"; fi
if printf 'bad output\n' | parse_cpu; then fail "bad CPU accepted"; else pass "bad CPU rejected"; fi
if printf 'bad output\n' | parse_disk; then fail "bad disk accepted"; else pass "bad disk rejected"; fi
[ "$(parse_vpns < "$DIR/fixtures/scutil-nc-list.txt")" = '[{"name":"Steeprock","status":"connected","kind":"ppp"}]' ] && pass 'real scutil output excludes Tailscale' || fail 'real scutil output'
for state in Connected Disconnected Connecting Disconnecting Unknown; do
  expected=$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')
  [ "$state" != Unknown ] || expected=disconnected
  result=$(printf '* (%s) id VPN "Office" [VPN:example]\n' "$state" | parse_vpns)
  [ "$result" = "[{\"name\":\"Office\",\"status\":\"$expected\",\"kind\":\"other\"}]" ] && pass "VPN $state" || fail "VPN $state"
done
result=$(printf '* (Connected) id VPN "TAILSCALE office" [VPN:example]\n* (Connected) id VPN "Private" [VPN:IO.TAILSCALE.example]\n' | parse_vpns)
[ "$result" = '[]' ] && pass 'Tailscale name and type excluded case insensitively' || fail 'Tailscale exclusion'
result=$(printf '* (connected) id PPP "Office \\ path "quoted"\tname" [PPP:L2TP]\n' | parse_vpns)
[ "$result" = '[{"name":"Office \\ path \"quoted\"\u0009name","status":"connected","kind":"ppp"}]' ] && pass 'VPN names escape backslash quote and control characters' || fail 'VPN JSON escaping'
[ "$(printf 'Available network connection services:\n' | parse_vpns)" = '[]' ] && pass 'empty VPN list' || fail 'empty VPN list'

# Exercise collection without invoking macOS commands or making HTTP requests.
PAYLOAD=$(mktemp)
trap 'rm -f "$PAYLOAD"' EXIT
top(){ cat "$DIR/fixtures/top.txt"; }
vm_stat(){ cat "$DIR/fixtures/vm_stat.txt"; }
sysctl(){ echo 17179869184; }
df(){ cat "$DIR/fixtures/df.txt"; }
scutil(){ [ "$SCUTIL_RESULT" = failure ] && return 1; [ "$SCUTIL_RESULT" = empty ] && return 0; cat "$DIR/fixtures/scutil-nc-list.txt"; }
curl(){ while [ "$#" -gt 0 ]; do if [ "$1" = -d ]; then shift; printf '%s' "$1" > "$PAYLOAD"; fi; shift; done; printf 204; }
SCUTIL_RESULT=success
report_once
case $(cat "$PAYLOAD") in *'"vpns":[{"name":"Steeprock","status":"connected","kind":"ppp"}]'*) pass 'successful collection includes VPNs';; *) fail 'VPN report';; esac
SCUTIL_RESULT=empty
report_once
case $(cat "$PAYLOAD") in *'"vpns":[]'*) pass 'successful empty collection reports []';; *) fail 'empty VPN report';; esac
SCUTIL_RESULT=failure
report_once
case $(cat "$PAYLOAD") in *'"vpns"'*) fail 'failed collection must omit VPNs';; *) pass 'failed collection omits VPNs';; esac
[ "$FAILS" = 0 ] && echo 'ALL PASS' || exit 1
