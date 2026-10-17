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
[ "$(printf '73.5\n' | parse_temp)" = 73.5 ] && pass 'temperature with a decimal' || fail 'temperature'
[ "$(printf '41\n' | parse_temp)" = 41 ] && pass 'whole temperature' || fail 'whole temperature'
for bad in '' 'nan' '-' '12 degrees' '1e3' '.5' 'Error: no sensors'; do
  if printf '%s\n' "$bad" | parse_temp >/dev/null; then fail "bad temperature accepted: $bad"; else pass "bad temperature rejected: $bad"; fi
done

result=$(parse_processes 501 8 104 $'104 1 /bin/bash /tmp/mac-reporter.sh\n105 104 /bin/sleep\n101 1 /bin/node' < "$DIR/fixtures/ps-processes.txt")
case "$result" in *'"pid":101,"name":"Codex Helper (Renderer)","app":"Codex","cpu":25.0000,"ram":4194304,"started":"Fri Oct 16 09:05:01 2026","own":true'*) pass 'process path, outer App, CPU normalization, RSS and start token';; *) fail 'process fields';; esac
case "$result" in *'"pid":104,'*'"own":false'*'"pid":105,'*'"own":false'*) pass 'reporter and descendants protected';; *) fail 'reporter protection';; esac
case "$result" in '[{"pid":102,'*'"own":false,'*) fail 'bad JSON';; '[{"pid":102,'*'"own":false}'*) pass 'RAM ordering and foreign uid';; *) fail 'RAM ordering and uid';; esac
case "$result" in *'"name":"tool \"quoted\"\\name.exe","app":"tool \"quoted\"\\name"'*) pass 'process JSON escaping and exe fallback';; *) fail 'process escaping';; esac
if printf '' | parse_processes 501 0 104 ''; then fail 'invalid core count accepted'; else pass 'invalid core count rejected'; fi
result=$(awk 'BEGIN { for(i=1;i<=405;i++) print i " 501 " (406-i) ".0 " i " Fri Oct 16 09:05:01 2026 /bin/node" }' | parse_processes 501 8 999 '')
[ "$(printf '%s' "$result" | tr '{' '\n' | wc -l | tr -d ' ')" = 400 ] && pass 'processes capped at 400' || fail 'process limit'
case "$result" in '[{"pid":405,'*'"pid":1,'*) pass 'highest RAM retained';; *) fail 'process RAM cap';; esac

# Bash is the real comm for the reporter; identify it by command ancestry.
result=$(printf '104 501 1.0 100 Fri Oct 16 09:05:01 2026 /bin/bash\n105 501 1.0 99 Fri Oct 16 09:05:01 2026 /bin/sleep\n106 501 1.0 98 Fri Oct 16 09:05:01 2026 /bin/bash\n' | parse_processes 501 8 106 $'104 1 /bin/bash /tmp/mac-reporter.sh\n105 104 /bin/sleep\n106 1 /bin/bash')
case "$result" in *'"pid":104,'*'"own":false}'*'"pid":105,'*'"own":false}'*'"pid":106,'*'"own":true}'*) pass 'actual reporter command protects bash and descendants; stale pid hint ignored';; *) fail 'bash reporter protection';; esac
result=$(printf '1 501 1.0 100 Fri Oct 16 09:05:01 2026 /bin/café\t\001\302\205\302\237\n' | parse_processes 501 8 999 '')
case "$result" in *'"name":"café"'*) pass 'process names strip control characters';; *) fail 'process control sanitization';; esac

# Exercise collection without invoking macOS commands or making HTTP requests.
PAYLOAD=$(mktemp)
TEMPS_DIR=$(mktemp -d)
trap 'rm -rf "$PAYLOAD" "$TEMPS_DIR"' EXIT
top(){ cat "$DIR/fixtures/top.txt"; }
vm_stat(){ cat "$DIR/fixtures/vm_stat.txt"; }
sysctl(){ [ "$2" = hw.logicalcpu ] && echo 8 || echo 17179869184; }
id(){ echo 501; }
ps(){ [ "$PS_RESULT" = failure ] && return 1; [ "$3" = pid=,ppid=,command= ] && { printf "104 1 /bin/bash /tmp/mac-reporter.sh\n105 104 /bin/sleep\n"; return; }; cat "$DIR/fixtures/ps-processes.txt"; }
PS_RESULT=success
df(){ cat "$DIR/fixtures/df.txt"; }
scutil(){ [ "$SCUTIL_RESULT" = failure ] && return 1; [ "$SCUTIL_RESULT" = empty ] && return 0; cat "$DIR/fixtures/scutil-nc-list.txt"; }
curl(){ while [ "$#" -gt 0 ]; do if [ "$1" = -d ]; then shift; printf '%s' "$1" > "$PAYLOAD"; fi; shift; done; printf 204; }
SCUTIL_RESULT=success
export HANGAR_TEMPS="$TEMPS_DIR/temps"
report_once
case $(cat "$PAYLOAD") in *'"temps"'*) fail 'no helper must omit temps';; *) pass 'no helper omits temps';; esac
printf '#!/bin/sh\necho 73.5\n' > "$HANGAR_TEMPS"
report_once
case $(cat "$PAYLOAD") in *'"temps"'*) fail 'non-executable helper must omit temps';; *) pass 'non-executable helper omits temps';; esac
chmod +x "$HANGAR_TEMPS"
report_once
case $(cat "$PAYLOAD") in *'"total":494384795648}],"temps":{"cpu":73.5},"vpns":'*) pass 'helper number reported as temps.cpu';; *) fail 'temps report';; esac
printf '#!/bin/sh\nexit 1\n' > "$HANGAR_TEMPS"
report_once
case $(cat "$PAYLOAD") in *'"temps"'*) fail 'failing helper must omit temps';; *) pass 'failing helper omits temps';; esac
printf '#!/bin/sh\necho oops\n' > "$HANGAR_TEMPS"
report_once
case $(cat "$PAYLOAD") in *'"temps"'*) fail 'non-number must omit temps';; *) pass 'non-number omits temps';; esac
report_once
case $(cat "$PAYLOAD") in *'"vpns":[{"name":"Steeprock","status":"connected","kind":"ppp"}]'*) pass 'successful collection includes VPNs';; *) fail 'VPN report';; esac
SCUTIL_RESULT=empty
report_once
case $(cat "$PAYLOAD") in *'"vpns":[]'*) pass 'successful empty collection reports []';; *) fail 'empty VPN report';; esac
SCUTIL_RESULT=failure
report_once
case $(cat "$PAYLOAD") in *'"vpns"'*) fail 'failed collection must omit VPNs';; *) pass 'failed collection omits VPNs';; esac
case $(cat "$PAYLOAD") in *'"processes":['*'"reporterPid":'*) pass 'successful process collection included';; *) fail 'process report';; esac
PS_RESULT=failure
report_once
case $(cat "$PAYLOAD") in *'"processes"'*|*'"reporterPid"'*) fail 'failed process collection included';; *) pass 'failed process collection omitted';; esac
[ "$FAILS" = 0 ] && echo 'ALL PASS' || exit 1
