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
[ "$FAILS" = 0 ] && echo 'ALL PASS' || exit 1
