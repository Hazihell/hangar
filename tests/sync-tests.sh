#!/bin/bash
# Scratch-HOME tests for bin/hangar. Never touches the real home.
# Works on macOS and GNU/Linux. Exits 1 if any case fails.
SRC="$(cd "$(dirname "$0")/.." && pwd)"; T=$(mktemp -d /tmp/agents-t.XXXX); cd $T
# systemctl reaches this user's real services whatever HOME is, so no test may run the real one.
mkdir -p $T/nosys; printf '#!/bin/sh\n[ "$2" = is-active ] && exit 3\nexit 0\n' > $T/nosys/systemctl; chmod +x $T/nosys/systemctl; export PATH=$T/nosys:$PATH
# setup on WSL asks Windows about HWiNFO; a drive that isn't there keeps every test away from the real one.
export HANGAR_C_DRIVE=$T/no-c-drive
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


# 11 `hangar outdated --json` and `hangar update <id>...`, with stub tools and a stub network
ST=$T/stubs; mkdir -p $ST; CALLS=$T/calls
stub(){ printf '#!/bin/sh\n%s\n' "$2" > $ST/$1; chmod +x $ST/$1; }
stub claude 'case "$1" in --version) echo "2.1.100 (Claude Code)" ;; *) echo "claude $*" >> '$CALLS'; [ -z "$CLAUDE_FAIL" ] || { echo "boom" >&2; exit 1; } ;; esac'
stub codex 'case "$1" in --version) echo "codex-cli 0.100.0" ;; *) echo "codex $*" >> '$CALLS' ;; esac'
stub t3 'case "$1" in --version) echo "t3 v0.0.1-nightly.20260101.1" ;; *) echo "t3 $*" >> '$CALLS' ;; esac'
stub gh 'echo "gh version 2.1.0 (2026-01-01)"'
stub tea 'printf "Version: \033[1m0.9.0\033[0m\tgolang: 1.2\n"'
stub apt-cache 'printf "gh:\n  Installed: 2.1.0\n  Candidate: 2.5.0-1\n"'
stub sudo '[ "$1" = -n ] && shift; if [ "$1" = true ]; then [ -z "$SUDO_FAIL" ]; exit; fi; [ -z "$SUDO_FAIL" ] || exit 1; echo "sudo $*" >> '$CALLS
stub curl 'u=""; for a in "$@"; do u="$a"; done
[ -z "$CURL_FAIL" ] || exit 22
case "$u" in
  *claude-code-releases/latest) echo 2.1.200 ;;
  *releases.openai.com/codex/channels/latest) printf "{\n  \"tag_name\": \"rust-v0.200.0\"\n}\n" ;;
  *pingdotgg/t3code/releases*) printf "  \"tag_name\": \"v0.1.0-preview.20260103.1\",\n  \"tag_name\": \"v0.1.0-nightly.20260102.5\",\n  \"tag_name\": \"v0.0.9\",\n" ;;
  *gitea.com/api/v1/repos/gitea/tea/releases/latest) echo "{\"id\":1,\"tag_name\":\"v0.10.0\",\"name\":\"v0.10.0\"}" ;;
  *) exit 22 ;;
esac'
stub brew 'case "$1" in update) ;; outdated) echo "gh (2.1.0) < 2.4.0" ;; list) ;; upgrade) echo "brew $*" >> '$CALLS' ;; esac'
stub launchctl '[ "$1" = print ] && exit 0; echo "launchctl $*" >> '$CALLS
stub darwin 'true'; rm $ST/darwin
mk C; C=$T/C; git clone -q $T/remote.git $T/D; git -C $T/D config user.email t@t; git -C $T/D config user.name d
SP=$ST:$T/nosys:/usr/bin:/bin
hg(){ HOME=$C PATH=$SP bash $C/.agents/bin/hangar "$@"; }   # Linux
hgm(){ HOME=$C PATH=$SP bash $C/.agents/bin/hangar "$@"; }
mac(){ printf '#!/bin/sh\n[ "$1" = -s ] && echo Darwin || exec /usr/bin/uname "$@"\n' > $ST/uname; chmod +x $ST/uname; }
unmac(){ rm -f $ST/uname; }
sha=$(git -C $C/.agents rev-parse --short HEAD)
item(){ printf '{"id":"%s","name":"%s","current":%s,"latest":%s,"available":%s,"blocked":%s' "$1" "$2" "$3" "$4" "$5" "$6"; }
want_head='{"items":['"$(item t3 "T3 Code" '"0.0.1-nightly.20260101.1"' '"0.1.0-nightly.20260102.5"' true null)"'},'"$(item claude "Claude Code" '"2.1.100"' '"2.1.200"' true null)"'},'"$(item codex Codex '"0.100.0"' '"0.200.0"' true null)"'},'"$(item gh "GitHub CLI" '"2.1.0"' '"2.5.0"' true null)"'},'"$(item tea "Gitea CLI" '"0.9.0"' '"0.10.0"' true null)"'},'
out=$(hg outdated --json 2>&1); rc=$?
[ $rc = 0 ] && [ "$out" = "$want_head$(item hangar Hangar "\"$sha\"" "\"$sha\"" false null),\"behind\":0}]}" ] && pass "11a outdated --json lists each installed tool's newest version" || { fail 11a; echo "$out"; }

# a missing network resolves nothing, but every item is still listed; no sudo blocks gh
out=$(CURL_FAIL=1 SUDO_FAIL=1 hg outdated --json 2>&1)
case "$out" in
  *'"id":"claude","name":"Claude Code","current":"2.1.100","latest":null,"available":false,"blocked":null'*'"id":"gh","name":"GitHub CLI","current":"2.1.0","latest":"2.5.0","available":true,"blocked":"Needs sudo; run '"'"'hangar update'"'"' on the PC"'*) pass "11b a failing lookup is null; gh without sudo is blocked" ;;
  *) fail 11b; echo "$out" ;;
esac

# hangar: behind, blocked by local changes or another branch
git -C $T/D commit -q --allow-empty -m "newer" && git -C $T/D push -q origin HEAD:main
out=$(hg outdated --json 2>&1); newsha=$(git -C $T/D rev-parse --short HEAD)
case "$out" in *"$(item hangar Hangar "\"$sha\"" "\"$newsha\"" true null),\"behind\":1}]}") pass "11c hangar is 1 behind" ;; *) fail 11c; echo "$out" ;; esac
echo dirty > $C/.agents/scratch.txt
out=$(hg outdated --json 2>&1)
case "$out" in *'"blocked":"Local changes in the checkout; run '"'"'hangar sync'"'"'","behind":1}'*) pass "11d local changes block hangar" ;; *) fail 11d; echo "$out" ;; esac
rm $C/.agents/scratch.txt; git -C $C/.agents checkout -q -b other
out=$(hg outdated --json 2>&1)
case "$out" in *"Checkout is on 'other', not main"*) pass "11e another branch blocks hangar" ;; *) fail 11e; echo "$out" ;; esac

# update <id>...: argument handling
: > $CALLS
hg update nope >$T/out 2>&1; rc=$?; hg update claude claude >>$T/out 2>&1; rc2=$?
[ $rc = 2 ] && [ $rc2 = 2 ] && grep -q 'unknown item: nope' $T/out && grep -q 'item given twice: claude' $T/out && [ ! -s $CALLS ] && pass "11f unknown and repeated ids are refused before anything runs" || { fail 11f; cat $T/out; }
hg update codex claude t3 gh </dev/null >$T/out 2>&1; rc=$?
[ $rc = 0 ] && [ "$(cat $CALLS)" = "$(printf 'codex update\nclaude update\nt3 update --yes\nsudo apt-get update -q\nsudo apt-get install -y -q --only-upgrade gh')" ] && pass "11g ids run in the order given, t3 with --yes, sudo without prompting" || { fail 11g; cat $CALLS $T/out; }
: > $CALLS
CLAUDE_FAIL=1 hg update claude codex </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 1 ] && [ "$(tail -n 1 $T/err)" = "Claude Code update failed" ] && grep -q '^codex update' $CALLS && pass "11h a failure exits 1 with a one-line reason, and the rest still run" || { fail 11h; cat $T/out $T/err; }
rm $ST/t3; hg update t3 </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 1 ] && [ "$(tail -n 1 $T/err)" = "T3 Code isn't installed here" ] && pass "11i an item that isn't installed fails" || { fail 11i; cat $T/out $T/err; }
stub node 'echo 24'   # the Dashboard needs Node 24 before hangar will pull
stub systemctl 'echo "systemctl $*" >> '$CALLS
stub npm 'exit 1'
: > $CALLS
hg update hangar </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 1 ] && [ "$(tail -n 1 $T/err)" = "Hangar: checkout is on 'other', not main" ] && ! grep -q systemctl $CALLS && pass "11j hangar refuses off main, without restarting the Dashboard" || { fail 11j; cat $T/out $T/err; }
git -C $C/.agents checkout -q main; echo dirty > $C/.agents/scratch.txt
hg update hangar </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 1 ] && tail -n 1 $T/err | grep -q 'local changes' && ! grep -q systemctl $CALLS && pass "11k hangar refuses with local changes, without restarting the Dashboard" || { fail 11k; cat $T/out $T/err; }
rm $C/.agents/scratch.txt

# one hangar update at a time: a live holder refuses a second, a dead one is stale; outdated never takes the lock
sleep 300 & HOLD=$!
mkdir -p $C/.local/state/hangar; ln -s $HOLD $C/.local/state/hangar/update.lock; : > $CALLS
hg update claude </dev/null >$T/out 2>$T/err; rc=$?; hg update </dev/null >$T/out2 2>$T/err2; rc2=$?
ran=$(wc -c < $CALLS)
out=$(hg outdated --json 2>&1)
[ $rc = 1 ] && [ $rc2 = 1 ] && [ "$(tail -n 1 $T/err)" = "Another hangar update is already running (pid $HOLD)" ] && [ "$(tail -n 1 $T/err2)" = "$(tail -n 1 $T/err)" ] && [ "$ran" -eq 0 ] && case "$out" in '{"items":['*) true ;; *) false ;; esac && pass "11n a running update refuses another, any form; outdated is unaffected" || { fail 11n; cat $T/err $T/err2 $CALLS; }
kill $HOLD; wait $HOLD 2>/dev/null
hg update codex </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 0 ] && grep -q '^codex update' $CALLS && [ ! -e $C/.local/state/hangar/update.lock ] && [ ! -L $C/.local/state/hangar/update.lock ] && pass "11o a lock whose holder died is taken over, and released afterwards" || { fail 11o; cat $T/err $CALLS; }

# a branch name with | or " must not break the document
git -C $C/.agents checkout -q -b 'feat"x|y'
out=$(hg outdated --json 2>&1)
case "$out" in *"\"blocked\":\"Checkout is on 'feat\\\"x|y', not main\",\"behind\":1}]}") pass "11p a branch named feat\"x|y is escaped" ;; *) fail 11p; echo "$out" ;; esac
if command -v python3 >/dev/null; then printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' && pass "11q ... and the document parses" || fail 11q
elif command -v node >/dev/null; then printf '%s' "$out" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' && pass "11q ... and the document parses" || fail 11q; fi
git -C $C/.agents checkout -q main; git -C $C/.agents branch -q -D 'feat"x|y'

# the per-command limit stops the whole tree and returns on time
eval "$(sed -n '/^descendants()/,/^}/p;/^kill_tree()/,/^}/p;/^run_limit()/,/^}/p' $SRC/bin/hangar)"
s0=$(date +%s); out=$(run_limit 0.1 sh -c 'sleep 2; echo late' 2>/dev/null); rc=$?; s1=$(date +%s)
[ -z "$out" ] && [ $rc != 0 ] && [ $((s1 - s0)) -le 1 ] && pass "11r a wrapper's descendants don't hold the limit up" || fail "11r took $((s1 - s0))s"
s0=$(date +%s); out=$(run_limit 0.3 sh -c 'trap "" TERM; sleep 30 & echo $! > '$T'/sleeper; wait' 2>/dev/null); s1=$(date +%s); sleep 0.3
if kill -0 "$(cat $T/sleeper)" 2>/dev/null; then fail "11s the TERM-ignoring tree survived"; kill -9 "$(cat $T/sleeper)"; elif [ $((s1 - s0)) -le 4 ]; then pass "11s a TERM-ignoring tree is killed within the grace period"; else fail "11s took $((s1 - s0))s"; fi
out=$(run_limit 5 sh -c 'echo fine'); [ "$out" = fine ] && pass "11t a command inside its limit keeps its output" || fail 11t

# macOS: Homebrew's gh and tea, and the reporter restarted after a pull
mac; : > $CALLS
out=$(hg outdated --json 2>&1)
case "$out" in
  *'"id":"gh","name":"GitHub CLI","current":"2.1.0","latest":"2.4.0","available":true,"blocked":null'*'"id":"tea","name":"Gitea CLI","current":"0.9.0","latest":"0.9.0","available":false,"blocked":null'*) pass "11l the Mac takes gh and tea from brew outdated" ;;
  *) fail 11l; echo "$out" ;;
esac
hg update gh tea hangar </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 0 ] && [ "$(cat $CALLS)" = "$(printf 'brew upgrade -q gh\nbrew upgrade -q tea\nlaunchctl kickstart -k gui/%s/com.hangar.reporter' $(id -u))" ] && [ "$(git -C $C/.agents rev-parse --short HEAD)" = "$newsha" ] && pass "11m Mac: brew upgrade, pull, then restart the reporter last" || { fail 11m; cat $CALLS $T/out $T/err; }
unmac

# a pull that succeeds but whose rebuild fails leaves the Dashboard running as it was
git -C $T/D commit -q --allow-empty -m "newer still" && git -C $T/D push -q origin HEAD:main; : > $CALLS
hg update hangar </dev/null >$T/out 2>$T/err; rc=$?
[ $rc = 1 ] && [ "$(git -C $C/.agents rev-parse HEAD)" = "$(git -C $T/D rev-parse HEAD)" ] && ! grep -q 'systemctl --user --no-block' $CALLS && pass "11u no restart when the rebuild after the pull failed" || { fail 11u; cat $CALLS $T/out $T/err; }
# 12 PC temperature: setup runs HWiNFO's one-time setup elevated through a stub Windows (WSL only)
if grep -qi microsoft /proc/version 2>/dev/null; then
  hg setup </dev/null >$T/out 2>&1; rc=$?
  [ $rc = 0 ] && grep -q "install HWiNFO64 for the PC's CPU temperature" $T/out && pass "12a no HWiNFO64: setup warns and goes on" || { fail 12a; cat $T/out; }
  WIN=$T/win; export HANGAR_C_DRIVE=$WIN; S32=$WIN/Windows/System32; mkdir -p "$S32/WindowsPowerShell/v1.0" "$WIN/Program Files/HWiNFO64" $T/appdata; : > "$WIN/Program Files/HWiNFO64/HWiNFO64.EXE"
  printf '#!/bin/sh\n[ -e %s/task ]\n' $T > $S32/schtasks.exe
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> %s/ps-calls\n[ -z "$PS_FAIL" ] || exit 1\ntouch %s/task\n' $T $T > $S32/WindowsPowerShell/v1.0/powershell.exe
  printf '#!/bin/sh\necho "C:\\Users\\t\\AppData\\Local\r"\n' > $S32/cmd.exe
  chmod +x $S32/schtasks.exe $S32/cmd.exe $S32/WindowsPowerShell/v1.0/powershell.exe
  stub wslpath '[ "$1" = -w ] && printf "%s\n" "W:\\appdata\\hangar\\hwinfo-setup.ps1" || echo '$T/appdata
  PS_FAIL=1 hg setup </dev/null >$T/out 2>&1; rc=$?
  [ $rc = 0 ] && grep -q "Approve the UAC prompt on the PC's screen" $T/out && grep -q "HWiNFO64 setup didn't finish" $T/out && [ ! -e $T/task ] && pass "12b a declined UAC prompt warns, setup still succeeds" || { fail 12b; cat $T/out; }
  hg setup </dev/null >$T/out 2>&1; rc=$?
  [ $rc = 0 ] && cmp -s $T/appdata/hangar/hwinfo-setup.ps1 $C/.agents/dashboard/windows/hwinfo-setup.ps1 && grep -q 'Start-Process powershell.exe -Verb RunAs -Wait -PassThru' $T/ps-calls && grep -qF 'W:\appdata\hangar\hwinfo-setup.ps1' $T/ps-calls && grep -q 'HWiNFO64 set up to start at logon' $T/out && pass "12c the script is copied to Windows and run elevated" || { fail 12c; cat $T/out $T/ps-calls; }
  : > $T/ps-calls; hg setup </dev/null >$T/out 2>&1; rc=$?
  [ $rc = 0 ] && [ ! -s $T/ps-calls ] && grep -q 'HWiNFO64 starts at logon' $T/out && pass "12d with the task in place, setup asks for nothing" || { fail 12d; cat $T/out $T/ps-calls; }
  export HANGAR_C_DRIVE=$T/no-c-drive
fi

rm -rf $T
if [ $FAILS = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
