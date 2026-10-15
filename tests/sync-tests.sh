#!/bin/bash
# Scratch-HOME tests for bin/hangar. Never touches the real home.
# Works on macOS and GNU/Linux. Exits 1 if any case fails.
SRC="$(cd "$(dirname "$0")/.." && pwd)"; T=$(mktemp -d /tmp/agents-t.XXXX); cd $T
pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; FAILS=1; }; FAILS=0
edit(){ perl -pi -e "$1" "$2"; }   # in-place edit; sed -i differs between BSD and GNU
# Seed a fresh repo from the working tree, without its .git, so no real remote is ever reachable
set -e
git init -q --bare -b main remote.git
mkdir seed; (cd "$SRC" && git ls-files -co --exclude-standard -z | while IFS= read -r -d "" f; do [ -e "$f" ] && printf "%s\0" "$f"; done | tar --null -T - -cf -) | tar -xf - -C seed
(cd seed && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed && git remote add origin "$T/remote.git" && git push -q -u origin main) >/dev/null 2>&1
[ "$(git -C seed remote)" = origin ] && [ "$(git -C seed remote get-url origin)" = "$T/remote.git" ]
set +e
mk(){ mkdir -p $T/$1; git clone -q $T/remote.git $T/$1/.agents; git -C $T/$1/.agents config user.email t@t; git -C $T/$1/.agents config user.name $1; HOME=$T/$1 bash $T/$1/.agents/bin/hangar setup >/dev/null; }
mk A; mk B; A=$T/A B=$T/B
run(){ HOME=$1 bash $1/.agents/bin/hangar sync >$T/out 2>&1; }
val(){ grep -o "\"$2\": \"[a-z]*\"" $1/.claude/settings.json | cut -d'"' -f4; }
setv(){ edit "s/\"$2\": \"[a-z]*\"/\"$2\": \"$3\"/" $1/.claude/settings.json; }

# 1 basic
setv $A theme light; echo "edit from A" >> $A/.agents/skills/coordinate/SKILL.md; run $A; run $B
[ "$(val $B theme)" = light ] && tail -1 $B/.agents/skills/coordinate/SKILL.md | grep -q 'edit from A' && pass "1 change flows A to B" || fail 1

# 2 different settings changed on both machines at once: both kept
setv $A theme blue; run $A; setv $B tui high; run $B; run $A
[ "$(val $A theme)$(val $A tui)$(val $B theme)$(val $B tui)" = bluehighbluehigh ] && pass "2 separate edits on both machines merge" || { fail 2; cat $T/out; }

# 3 same setting both sides: git conflict, resolve to green, both end green
setv $A theme red; run $A; setv $B theme pink; run $B; rc=$?
[ $rc = 1 ] && grep -q 'changed the same lines' $T/out && pass "3a conflict stops sync" || { fail 3a; cat $T/out; }
(cd $B/.agents && git show :2:claude/settings.json > claude/settings.json && perl -pi -e 's/"theme": "red"/"theme": "green"/' claude/settings.json && git add -A && GIT_EDITOR=true git rebase --continue >/dev/null 2>&1)
run $B; run $A
[ "$(val $A theme)$(val $B theme)" = greengreen ] && pass "3b resolved value wins on both" || { fail 3b; cat $T/out; }

# 4 missing seen file
rm $B/.claude/.hangar-settings-seen; setv $B theme stale; run $B; rc=$?
[ $rc = 1 ] && grep -q "no record of which is newer" $T/out && [ "$(grep -o '"theme": "[a-z]*"' $B/.agents/claude/settings.json | cut -d'"' -f4)" = green ] && pass "4a missing baseline refuses, repo copy intact" || { fail 4a; cat $T/out; }
setv $B theme green; run $B && pass "4b missing baseline with equal copies proceeds" || { fail 4b; cat $T/out; }

# 5 Claude edits settings while sync runs (pre-push hook edits the live file)
printf '#!/bin/sh\nperl -pi -e "s/\\"tui\\": \\"[a-z]*\\"/\\"tui\\": \\"max\\"/" %s/.claude/settings.json\n' $A > $A/.agents/.git/hooks/pre-push; chmod +x $A/.agents/.git/hooks/pre-push
setv $A theme cyan; run $A; rc=$?
[ $rc = 1 ] && [ "$(val $A tui)" = max ] && pass "5a mid-sync edit kept, sync warns" || { fail 5a; cat $T/out; }
rm $A/.agents/.git/hooks/pre-push; run $A; run $B
[ "$(val $B tui)$(val $B theme)" = maxcyan ] && pass "5b next sync carries both edits" || { fail 5b; cat $T/out; }

# 6 backups in the same second don't collide
for i in 1 2; do rm $A/.claude/CLAUDE.md; echo "plain $i" > $A/.claude/CLAUDE.md; HOME=$A bash $A/.agents/bin/hangar setup >/dev/null; done
n=$(grep -rl '^plain [12]$' $A/.hangar-backup | wc -l | tr -d ' '); [ "$n" = 2 ] && pass "6 two backups kept" || fail "6 found $n"

# 7 rejected push fails loudly
printf '#!/bin/sh\nexit 1\n' > $T/remote.git/hooks/pre-receive; chmod +x $T/remote.git/hooks/pre-receive
echo x >> $A/.agents/skills/coordinate/SKILL.md; run $A; rc=$?
[ $rc = 1 ] && grep -q 'Push failed' $T/out && ! grep -q 'Up to date' $T/out && pass "7 rejected push exits 1" || { fail 7; cat $T/out; }
rm $T/remote.git/hooks/pre-receive

# 8 npm ci failure fails setup
mkdir -p $T/fakebin; printf '#!/bin/sh\nexit 42\n' > $T/fakebin/npm; chmod +x $T/fakebin/npm
rm -rf $A/.agents/skills/gh-release/node_modules
HOME=$A PATH=$T/fakebin:$PATH bash $A/.agents/bin/hangar setup >$T/out 2>&1; rc=$?
[ $rc = 1 ] && grep -q 'npm ci failed' $T/out && pass "8 npm failure exits 1" || { fail 8; cat $T/out; }

# 8b a half-finished install is retried, not skipped
mkdir -p $A/.agents/skills/gh-release/node_modules
HOME=$A PATH=$T/fakebin:$PATH bash $A/.agents/bin/hangar setup >$T/out 2>&1; rc=$?
[ $rc = 1 ] && grep -q 'npm ci failed' $T/out && pass "8b failed install retried on next setup" || { fail 8b; cat $T/out; }

# 10 failed commit stops sync
printf '#!/bin/sh\nexit 1\n' > $A/.agents/.git/hooks/pre-commit; chmod +x $A/.agents/.git/hooks/pre-commit
echo y >> $A/.agents/skills/coordinate/SKILL.md; run $A; rc=$?
[ $rc = 1 ] && grep -q 'Commit failed' $T/out && ! grep -q 'Up to date' $T/out && pass "10 failed commit exits 1" || { fail 10; cat $T/out; }
rm $A/.agents/.git/hooks/pre-commit

# 9 .wslconfig parsing
set -o pipefail; eval "$(sed -n '/^ini_get()/,/^}/p' $SRC/bin/hangar)"   # pipefail as in bin/hangar
printf '[wsl2]\r\nmemory = 16GB # cap\r\nprocessors=8\r\n[general]\r\ninstanceIdleTimeout=-1\r\n' > $T/good.ini
printf '[general]\nmemory=16GB\ninstanceIdleTimeout=-10\n[wsl2]\nprocessors=8\n' > $T/bad.ini
[ "$(ini_get general instanceIdleTimeout $T/good.ini)|$(ini_get wsl2 memory $T/good.ini)" = "-1|16GB" ] && pass "9a CRLF file with comments parses" || fail "9a"
[ "$(ini_get general instanceIdleTimeout $T/bad.ini)|$(ini_get wsl2 memory $T/bad.ini)" = "-10|" ] && pass "9b wrong value and wrong section rejected" || fail "9b"

rm -rf $T
if [ $FAILS = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
