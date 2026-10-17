import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from './server.ts';
import { quitCommand, quitProcesses } from './quit.ts';
import type { Local } from './quit.ts';
const pc = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
const mac = { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' };
const p = { pid: 123456, name: 'node', app: 'node', cpu: 1, ram: 2, started: "token '‘; echo unsafe", own: true };
const target = { pid: p.pid, started: p.started };
const forbidden = () => { throw new Error('must not reach execution'); };
test('remote commands keep opaque identity tokens as data for Windows and POSIX shells', () => {
  const command = quitCommand(pc, [target], true, { windows: new Set([22]) })!;
  assert.equal(command.file, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.deepEqual(command.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand']);
  const source = Buffer.from(command.args.at(-1)!, 'base64').toString('utf16le');
  assert.equal(source.includes(p.started), false);
  const encoded = source.match(/FromBase64String\('([^']+)'\)/)![1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), { targets: [target], force: true, protected: [22] });
  const ssh = quitCommand(mac, [target], false, {}, 77)!;
  assert.deepEqual(ssh.args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'user@mac']);
  assert.ok(ssh.args[5].endsWith("sh 0 77 123456 'token '\\''‘; echo unsafe'"));
});
test('protected or unknown targets never reach execution; stale identity returns changed', async () => {
  const results = await quitProcesses(pc, [target, { pid: 3, started: '' }, { pid: 4, started: 'old' }], false,
    { processes: [{ ...p, own: false }, { ...p, pid: 4 }] }, {}, forbidden);
  assert.deepEqual(results, [{ pid: p.pid, result: 'protected' }, { pid: 3, result: 'gone' }, { pid: 4, result: 'changed' }]);
});
test('Windows and Mac parse one ordered result per target and preserve failures', async () => {
  for (const machine of [pc, mac]) {
    const results = await quitProcesses(machine, [target, { ...target, pid: 2 }], true, { processes: [p, { ...p, pid: 2 }] }, {}, (_file, _args, options, done) => {
      assert.equal(options.timeout, 20000);
      done(null, machine === pc ? JSON.stringify([{ pid: p.pid, result: 'sent' }, { pid: 2, result: 'failed', message: 'Não foi possível' }]) : `${p.pid}\tsent\n2\tfailed\n`, '');
    });
    assert.equal(results[0].result, 'sent'); assert.equal(results[1].result, 'failed'); assert.ok(results[1].message);
  }
  const failed = await quitProcesses(pc, [target], false, { processes: [p] }, {}, (_f, _a, _o, done) => done({ killed: true }, '', ''));
  assert.equal(failed[0].message, 'Command timed out');
});
test('WSL checks current uid, executable and identity before injected signals', async () => {
  let current = { pid: p.pid, name: 'node', started: p.started, uid: 1000, ppid: 1, ticks: 0, ram: 2 };
  const signals: unknown[] = [];
  const local: Local = { uid: 1000, read: () => current, quit: (...args) => { signals.push(args); } };
  const run = (force = false) => quitProcesses(pc, [{ ...target, where: 'wsl' }], force, { wsl: [p] }, {}, forbidden, local);
  assert.equal((await run())[0].result, 'sent'); assert.deepEqual(signals, [[p.pid, 'SIGTERM']]);
  await run(true); assert.deepEqual(signals[1], [p.pid, 'SIGKILL']);
  current = { ...current, uid: 0 }; assert.equal((await run())[0].result, 'protected');
  current = { ...current, uid: 1000, name: 'sshd' }; assert.equal((await run())[0].result, 'protected');
  current = { ...current, name: 'node', started: 'new' }; assert.equal((await run())[0].result, 'changed');
  local.read = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }; assert.equal((await run())[0].result, 'gone');
  local.read = () => ({ ...current, started: p.started }); local.quit = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); };
  assert.deepEqual((await run())[0], { pid: p.pid, result: 'failed', message: 'permission denied' });
  assert.equal(signals.length, 2);
});
test('HTTP exposes Apps and minute Top Apps and bounds Quit without real Process actions', async t => {
  let now = 120000;
  let calls = 0;
  const app = createDashboard({ db: ':memory:', machines: [pc, mac, { ...mac, id: 'unreachable', ssh: undefined }], clock: () => now, collect: false, exec: (_f, _a, _o, done) => { calls++; done(null, JSON.stringify([{ pid: p.pid, result: 'sent' }]), ''); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = (path: string, body: unknown, type = 'application/json') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
  const report = { machine: 'pc', cpu: 1, ram: { used: 1, total: 2 }, disks: [], processes: [p] };
  assert.equal((await post('/api/report', report)).status, 204);
  let state = (await (await fetch(base + '/api/machines')).json()).machines[0];
  assert.equal(state.apps.list[0].name, 'node'); assert.equal(state.usage.processes, undefined);
  await post('/api/report', { ...report, processes: undefined });
  state = (await (await fetch(base + '/api/machines')).json()).machines[0]; assert.equal(state.apps.list[0].name, 'node');
  const minute = '/api/machines/pc/minutes/1970-01-01T00%3A02%3A00.000Z';
  assert.equal((await fetch(minute.replace('/api', base + '/api'))).status, 200);
  assert.equal((await fetch(base + '/api/machines/missing/minutes/1970-01-01T00:02:00.000Z')).status, 404);
  assert.equal((await fetch(base + '/api/machines/pc/minutes/1970-01-01T00:03:00.000Z')).status, 404);
  const body = { targets: [target], force: false };
  assert.equal((await post('/api/machines/pc/quit', body, 'text/plain')).status, 400);
  assert.equal((await post('/api/machines/pc/quit', { ...body, force: 'true' })).status, 400);
  assert.equal((await post('/api/machines/unknown/quit', body)).status, 404);
  assert.equal((await post('/api/machines/unreachable/quit', body)).status, 404);
  assert.equal((await post('/api/machines/pc/quit', body)).status, 200); assert.equal(calls, 1);
  await post('/api/report', { ...report, processes: [{ ...p, own: false }] });
  assert.equal((await (await post('/api/machines/pc/quit', body)).json()).results[0].result, 'protected'); assert.equal(calls, 1);
  now += 30000; assert.equal((await post('/api/machines/pc/quit', body)).status, 409);
});
test('Mac Quit script checks identity and ancestry before a stubbed signal', async () => {
  const { execFileSync } = await import('node:child_process');
  const remote = quitCommand(mac, [target, { pid: 2, started: 'old' }, { pid: 3, started: 'now' }, { pid: 4, started: 'now' }, { pid: 5, started: 'now' }], true, {}, 77)!.args[5];
  // Both OS interfaces are shell functions; this cannot reach a real signal.
  const harness = `
ps() {
  case "$*" in
    '-o lstart= -p 123456') printf '%s\\n' "token '\u2018; echo unsafe";;
    '-o lstart= -p 2') echo new;;
    '-o lstart= -p 3') :;;
    '-o lstart= -p 4'|'-o lstart= -p 5') echo now;;
    '-o uid= -p '*) id -u;;
    '-o comm= -p '*) echo /usr/bin/node;;
    '-o ppid= -p 4') echo 77;;
    '-o ppid= -p '*) echo 1;;
    *) return 1;;
  esac
}
kill() { printf '%s\\n' "stubbed:$*" >&2; [ "$2" != 5 ]; }
sh() { shift; code=$1; shift; shift; eval "$code"; }
${remote}`;
  const output = execFileSync('/bin/sh', ['-c', harness], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const rows = output.trim().split('\n').map(line => line.split('\t'));
  assert.deepEqual(rows.map(row => row.slice(0, 2)), [['123456', 'sent'], ['2', 'changed'], ['3', 'gone'], ['4', 'protected'], ['5', 'failed']]);
  assert.match(Buffer.from(rows[4][2], 'base64').toString('utf8'), /stubbed:-KILL 5/);
});
test('Windows Quit script checks identity and session before stubbed taskkill', async t => {
  const { existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const exe = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!existsSync(exe)) { t.skip('Windows PowerShell unavailable'); return; }
  const command = quitCommand(pc, [target, { pid: 2, started: 'old' }, { pid: 3, started: 'now' }, { pid: 4, started: 'now' }, { pid: 5, started: 'now' }, { pid: 6, started: 'now' }], false)!;
  const source = Buffer.from(command.args.at(-1)!, 'base64').toString('utf16le');
  const harness = `
function Get-Process {
  param([int]$Id, [string]$ErrorAction)
  if ($Id -eq $PID) { return [pscustomobject]@{SessionId=7} }
  if ($Id -eq 3) { return $null }
  $started = switch ($Id) { 123456 { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(p.started).toString('base64')}')) } 2 { 'new' } default { 'now' } }
  $sessionId = if ($Id -eq 6) { 0 } else { 7 }
  $name = if ($Id -eq 4) { 'explorer' } else { 'node' }
  $process = [pscustomobject]@{Id=$Id;ProcessName=$name;SessionId=$sessionId;StartTime=[pscustomobject]@{Ticks=$started}}
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
  $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
  $process
}
function taskkill.exe { $global:LASTEXITCODE = if ($args -contains '5') { 1 } else { 0 }; 'stubbed taskkill' }
${source}`;
  const args = [...command.args.slice(0, -1), Buffer.from(harness, 'utf16le').toString('base64')];
  const results = JSON.parse(execFileSync(exe, args, { encoding: 'utf8', timeout: 20000 }).trim());
  assert.deepEqual(results.map((row: any) => row.result), ['sent', 'changed', 'gone', 'protected', 'failed', 'protected']);
  assert.equal(results[4].message, 'stubbed taskkill');
  // Build the force variant through the command builder so its encoded payload stays intact.
  const forceCommand = quitCommand(pc, [target, { pid: 5, started: 'now' }, { pid: 6, started: 'now' }], true)!;
  const forceProgram = Buffer.from(forceCommand.args.at(-1)!, 'base64').toString('utf16le');
  const forceHarness = harness.slice(0, harness.indexOf(source)).replace('$process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}', `$process | Add-Member -MemberType ScriptMethod -Name Kill -Value { if ($this.Id -eq 5) { throw 'stubbed Kill refused' } }`)
    .replace("function taskkill.exe {", "function taskkill.exe { throw 'force must use verified Process';") + forceProgram;
  const forceResults = JSON.parse(execFileSync(exe, [...command.args.slice(0, -1), Buffer.from(forceHarness, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000 }).trim());
  assert.deepEqual(forceResults.map((row: any) => row.result), ['sent', 'failed', 'protected']);
  assert.match(forceResults[1].message, /stubbed Kill refused/);
});

test('Mac protects ssh titles, reporter command ancestry, and its own ancestors without a reporter hint', async () => {
  const { execFileSync } = await import('node:child_process');
  const targets = [11, 12, 13, 14].map(pid => ({ pid, started: 'now' }));
  const remote = quitCommand(mac, targets, false)!.args[5];
  const harness = `
ps() {
  case "$*" in
    '-o lstart= -p '*) echo now;;
    '-o uid= -p '*) id -u;;
    '-o comm= -p 11') echo 'sshd-session: user [priv]';;
    '-o comm= -p '*) echo /bin/bash;;
    '-o command= -p 12'|'-o command= -p 77') echo '/bin/bash /Users/user/bin/mac-reporter.sh';;
    '-o command= -p '*) echo '/bin/bash worker.sh';;
    "-o ppid= -p $$") echo 14;;
    '-o ppid= -p 13') echo 77;;
    '-o ppid= -p '*) echo 1;;
  esac
}
kill() { echo 'unexpected signal' >&2; return 1; }
sh() { shift; code=$1; shift; shift; eval "$code"; }
${remote}`;
  const rows = execFileSync('/bin/sh', ['-c', harness], { encoding: 'utf8' }).trim().split('\n').map(row => row.split('\t').slice(0, 2));
  assert.deepEqual(rows, targets.map(t => [String(t.pid), 'protected']));
});
test('Windows chunks 200 targets into commands below the Windows command line limit and preserves missing acknowledgements', async () => {
  const processes = Array.from({ length: 200 }, (_, i) => ({ ...p, pid: 100 + i, started: 'x'.repeat(64) }));
  let calls = 0;
  const results = await quitProcesses(pc, processes.map(({ pid, started }) => ({ pid, started })), true, { processes }, {}, (_file, args, _options, done) => {
    calls++;
    assert.ok(args.join(' ').length < 32767);
    const source = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    assert.match(source, /\$p\.Kill\(\)/);
    assert.match(source, /\$session -le 0/);
    const encoded = source.match(/FromBase64String\('([^']+)'\)/)![1];
    const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.ok(data.targets.length <= 80);
    done(null, JSON.stringify([{ pid: data.targets[0].pid, result: 'sent' }]), '');
  });
  assert.equal(calls, 3);
  assert.equal(results.filter(r => r.result === 'sent').length, 3);
  assert.equal(results[1].message, 'No result from Machine');
});

test('Windows command batches fit even when opaque tokens expand as UTF-8 and JSON escapes', async () => {
  for (const started of ['漢'.repeat(64), '\0'.repeat(64)]) {
    const processes = Array.from({ length: 200 }, (_, i) => ({ ...p, pid: 100 + i, started }));
    const results = await quitProcesses(pc, processes.map(({ pid, started }) => ({ pid, started })), true, { processes }, {}, (file, args, _options, done) => {
      assert.ok(file.length + args.join(' ').length + 64 < 32767);
      const source = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      const data = JSON.parse(Buffer.from(source.match(/FromBase64String\('([^']+)'\)/)![1], 'base64').toString('utf8'));
      done(null, JSON.stringify(data.targets.map((t: any) => ({ pid: t.pid, result: 'sent' }))), '');
    });
    assert.equal(results.length, 200); assert.ok(results.every(r => r.result === 'sent'));
  }
});
test('partial SSH acknowledgements survive timeout and unacknowledged targets retain No result from Machine', async () => {
  const results = await quitProcesses(mac, [target, { ...target, pid: 2 }], false, { processes: [p, { ...p, pid: 2 }] }, {}, (_file, _args, _options, done) => done({ killed: true }, `${p.pid}\tsent\n`, ''));
  assert.deepEqual(results, [{ pid: p.pid, result: 'sent' }, { pid: 2, result: 'failed', message: 'No result from Machine' }]);
});
