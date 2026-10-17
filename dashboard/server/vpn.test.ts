import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from './server.ts';
import { Usage, acceptReport } from './usage.ts';
import { createVpn } from './vpn.ts';
import type { Exec } from './vpn.ts';
import { Store } from './store.ts';
const machines = [
  { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' },
  { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' },
  { id: 'unreachable', name: 'Other', os: 'macos', collector: 'mac' },
];
const report = { machine: 'pc', cpu: 10, ram: { used: 1, total: 2 }, disks: [] };
const vpn = { name: "Office's VPN", status: 'disconnected' as const, kind: 'ppp' as const };
async function fixture(t: any, throws = false) {
  let now = 120_000;
  const calls: { file: string; args: string[]; options: { timeout: number }; done: (error: any, stdout: string, stderr: string) => void }[] = [];
  const app = createDashboard({ db: ':memory:', machines, collect: false, clock: () => now,
    exec: (file, args, options, done) => { calls.push({ file, args, options, done }); if (throws) throw new Error('spawn failed'); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.listening ? app.close() : undefined);
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) });
  const send = (value: any = {}) => post('/api/report', { ...report, vpns: [vpn], ...value });
  const command = (machine = 'pc', name = vpn.name, action = 'connect') => post(`/api/machines/${machine}/vpns/${encodeURIComponent(name)}`, { action });
  const get = async (id = 'pc') => (await (await fetch(base + '/api/machines')).json()).machines.find((m: any) => m.id === id);
  return { app, base, calls, post, send, command, get, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; app.tick(); } };
}
test('VPN validation accepts only bounded names, four statuses and known kinds', () => {
  for (const status of ['connected', 'disconnected', 'connecting', 'disconnecting']) assert.ok(acceptReport({ ...report, vpns: [{ ...vpn, status }] }));
  assert.ok(acceptReport({ ...report, vpns: [] }));
  assert.ok(acceptReport({ ...report, vpns: [{ ...vpn, name: 'a'.repeat(256), kind: 'other' }] }));
  for (const vpns of [null, {}, [null], [{}], [{ ...vpn, name: '' }], [{ ...vpn, name: 'a'.repeat(257) }], [{ ...vpn, name: 1 }], [{ ...vpn, status: 'invalid' }], [{ ...vpn, kind: 'l2tp' }]]) assert.equal(acceptReport({ ...report, vpns }), null);
});
test('VPNs persist across restart, omitted lists retain known VPNs, and empty lists clear them', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vpn-')); t.after(() => rmSync(dir, { recursive: true }));
  const db = join(dir, 'test.db');
  let store = new Store(db), usage = new Usage(store.db, machines);
  usage.intake({ ...report, vpns: [vpn] }, 1); usage.intake(report, 2); store.close();
  store = new Store(db); usage = new Usage(store.db, machines);
  try {
    const state = usage.snapshot(machines[0], 3);
    assert.deepEqual(state.vpns, [{ name: vpn.name, status: 'disconnected', pending: null, error: null }]);
    assert.equal('vpns' in state.usage!, false);
    assert.equal('ssh' in usage.snapshot(machines[1], 3), false);
    usage.intake({ ...report, vpns: [] }, 4); assert.deepEqual(usage.snapshot(machines[0], 4).vpns, []);
  } finally { store.close(); }
});
test('PC VPN commands pass exact safe arguments and wait for reports after successful execution', async t => {
  const f = await fixture(t);
  await f.send();
  assert.deepEqual((await f.get()).vpns, [{ name: vpn.name, status: 'disconnected', pending: null, error: null }]);
  assert.equal((await f.command()).status, 202);
  const call = f.calls[0];
  assert.equal(call.file, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.deepEqual(call.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand']);
  assert.equal(Buffer.from(call.args.at(-1)!, 'base64').toString('utf16le'), `& {\n${readFileSync(new URL('./vpn-windows.ps1', import.meta.url), 'utf8')}\n} -Name ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('T2ZmaWNlJ3MgVlBO')))`);
  assert.deepEqual(call.options, { timeout: 80_000, encoding: 'utf8' });
  call.done(null, '', '');
  assert.deepEqual((await f.get()).vpns[0].pending, { action: 'connect', since: '1970-01-01T00:02:00.000Z' });
  await f.send({ vpns: [{ ...vpn, status: 'connecting' }] }); assert.ok((await f.get()).vpns[0].pending);
  await f.send({ vpns: [{ ...vpn, status: 'connected' }] }); assert.equal((await f.get()).vpns[0].pending, null);
  assert.equal((await f.command('pc', vpn.name, 'disconnect')).status, 202);
  assert.deepEqual(f.calls[1].args, [vpn.name, '/disconnect']);
  assert.equal(f.calls[1].file, '/mnt/c/Windows/System32/rasdial.exe'); assert.deepEqual(f.calls[1].options, { timeout: 20_000, encoding: 'utf8' });
  await f.send(); assert.equal((await f.get()).vpns[0].pending, null);
});
test('Mac VPN commands quote names for PPP connect, other connect, and disconnect', async t => {
  const f = await fixture(t);
  for (const [kind, action, command] of [['ppp', 'connect', '/usr/sbin/networksetup -connectpppoeservice'], ['other', 'connect', '/usr/sbin/scutil --nc start'], ['other', 'disconnect', '/usr/sbin/scutil --nc stop']]) {
    await f.send({ machine: 'mac', vpns: [{ ...vpn, kind }] });
    assert.equal((await f.command('mac', vpn.name, action)).status, 202);
    const call = f.calls.at(-1)!;
    assert.equal(call.file, 'ssh');
    assert.deepEqual(call.args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'user@mac', `${command} 'Office'\\''s VPN'`]);
    assert.deepEqual(call.options, { timeout: 30_000, encoding: 'utf8' });
    await f.send({ machine: 'mac', vpns: [{ ...vpn, kind, status: action === 'connect' ? 'connected' : 'disconnected' }] });
  }
});
test('VPN endpoint rejects malformed, missing, Offline and pending requests without running commands', async t => {
  const f = await fixture(t);
  await f.send();
  for (const value of [{ action: 'toggle' }, null, {}, { action: 1 }]) assert.equal((await f.post('/api/machines/pc/vpns/Office', value)).status, 400);
  assert.equal((await fetch(f.base + '/api/machines/pc/vpns/Office', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(f.base + '/api/machines/pc/vpns/' + encodeURIComponent(vpn.name), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'connect' }) })).status, 400);
  assert.equal((await f.command('unknown')).status, 404);
  assert.equal((await f.command('pc', 'missing')).status, 404);
  await f.send({ machine: 'unreachable' }); assert.equal((await f.command('unreachable')).status, 404);
  f.advance(30_000); assert.equal((await f.command()).status, 409);
  assert.equal(f.calls.length, 0);
  await f.send(); assert.equal((await f.command()).status, 202);
  assert.equal((await f.command()).status, 409); assert.equal(f.calls.length, 1);
  assert.equal((await f.send({ vpns: [{ ...vpn, status: 'bad' }] })).status, 400);
});
test('command failures clear pending, retain a short error, and new commands clear it', async t => {
  const f = await fixture(t); await f.send(); await f.command();
  f.calls[0].done({ code: 628 }, '', 'intro\r\n\u0001Could not connect\r\n\n');
  assert.deepEqual((await f.get()).vpns[0], { name: vpn.name, status: 'disconnected', pending: null, error: { message: 'Could not connect', at: '1970-01-01T00:02:00.000Z' } });
  await f.send(); assert.equal((await f.get()).vpns[0].error.message, 'Could not connect');
  await f.command(); assert.equal((await f.get()).vpns[0].error, null);
  f.calls[1].done({ code: 1 }, 'last stdout\n', ''); assert.equal((await f.get()).vpns[0].error.message, 'last stdout');
  await f.command(); f.calls[2].done({ code: 7 }, '', ''); assert.equal((await f.get()).vpns[0].error.message, 'exit code 7');
  await f.command(); f.calls[3].done({ killed: true }, '', ''); assert.equal((await f.get()).vpns[0].error.message, 'Command timed out');
});
test('90 seconds without confirmation times out and disappearing VPNs discard command state', async t => {
  const f = await fixture(t); await f.send(); await f.command();
  f.calls[0].done(null, '', '');
  f.advance(89_999); assert.ok((await f.get()).vpns[0].pending);
  f.advance(1); assert.deepEqual((await f.get()).vpns[0].error, { message: 'No change after 90 s', at: '1970-01-01T00:03:30.000Z' });
  assert.equal((await f.get()).vpns[0].pending, null);
  await f.send(); await f.command(); await f.send({ vpns: [] });
  f.calls[1].done({ code: 1 }, '', 'late failure');
  await f.send(); assert.deepEqual((await f.get()).vpns[0], { name: vpn.name, status: 'disconnected', pending: null, error: null });
});
test('SSE includes VPN command start, report confirmation, failure and timeout changes', async t => {
  const f = await fixture(t); await f.send();
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(f.base + '/api/events', { signal: abort.signal });
  const reader = stream.body!.getReader(); await reader.read();
  const event = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1].trim());
  await f.command(); assert.equal((await event()).vpns[0].pending.action, 'connect');
  await f.send({ vpns: [{ ...vpn, status: 'connected' }] }); assert.equal((await event()).vpns[0].pending, null);
  await f.command('pc', vpn.name, 'disconnect'); await event();
  f.calls[1].done({ code: 1 }, '', 'failed'); assert.equal((await event()).vpns[0].error.message, 'failed');
  await f.command('pc', vpn.name, 'disconnect'); await event();
  f.advance(90_000); assert.equal((await event()).vpns[0].error.message, 'No change after 90 s');
  await reader.cancel();
});

test('VPN confirmation deadline fires at 90 seconds with fake timers', async t => {
  const f = await fixture(t); await f.send();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.command();
  f.setNow(209_999); t.mock.timers.tick(90_000); t.mock.timers.reset();
  assert.deepEqual((await f.get()).vpns[0].error, { message: 'No change after 90 s', at: '1970-01-01T00:03:30.000Z' });
});

test('VPN names reject Windows switches, quoting and control characters', () => {
  for (const name of ['-entry', '/entry', 'a"b', 'a\nb', 'a\rb', 'a\tb', 'a\0b', 'a\x7fb', 'a\u0085b'])
    assert.equal(acceptReport({ ...report, vpns: [{ ...vpn, name }] }), null, JSON.stringify(name));
});
test('synchronous exec failure is reported', async t => {
  const f = await fixture(t, true); await f.send();
  assert.equal((await f.command()).status, 202);
  assert.equal((await f.get()).vpns[0].pending, null);
  assert.ok((await f.get()).vpns[0].error);
});
test('failure after report confirmation does not overwrite confirmed success', async t => {
  const f = await fixture(t); await f.send(); await f.command();
  await f.send({ vpns: [{ ...vpn, status: 'connected' }] });
  f.calls[0].done({ code: 1 }, '', 'late failure');
  assert.equal((await f.get()).vpns[0].error, null);
});
test('Mac report without a previously known VPN discards pending and late failures', async t => {
  const f = await fixture(t); await f.send({ machine: 'mac' }); await f.command('mac');
  await f.send({ machine: 'mac', vpns: [] });
  f.calls[0].done({ code: 1 }, '', 'late failure');
  await f.send({ machine: 'mac' });
  assert.deepEqual((await f.get('mac')).vpns[0], { name: vpn.name, status: 'disconnected', pending: null, error: null });
});
test('late command callback after server close does nothing', async t => {
  const f = await fixture(t); await f.send(); await f.command();
  await f.app.close();
  assert.doesNotThrow(() => f.calls[0].done({ code: 1 }, '', 'late failure'));
});
test('a report reaching the last target clears timeout and command errors', async t => {
  const f = await fixture(t); await f.send(); await f.command();
  f.calls[0].done({ killed: true }, '', '');
  await f.send(); assert.ok((await f.get()).vpns[0].error);
  await f.send({ vpns: [{ ...vpn, status: 'connected' }] });
  assert.equal((await f.get()).vpns[0].error, null);
  await f.command('pc', vpn.name, 'disconnect'); f.advance(90_000);
  await f.send(); assert.equal((await f.get()).vpns[0].error, null);
  await f.command(); f.calls.at(-1)!.done({ code: 628 }, '', 'real failure');
  await f.send({ vpns: [{ ...vpn, status: 'connected' }] });
  assert.equal((await f.get()).vpns[0].error, null);
});

// The module itself, without the server around it.
function module(t: any, throws = false) {
  let now = 120_000, online = true;
  const calls: { file: string; args: string[]; options: { timeout: number }; done: Parameters<Exec>[3] }[] = [];
  const emitted: { machine: string; at: number }[] = [];
  let known = [vpn];
  const startedWhile: { at: number; calls: number; pending?: string }[] = [];
  const subject = createVpn({ clock: () => now, vpns: () => known, online: () => online,
    emit: (machine, at) => emitted.push({ machine: machine.id, at }),
    started: at => { startedWhile.push({ at, calls: calls.length, pending: subject.state('pc', [vpn])[0].pending?.action }); },
    exec: (file, args, options, done) => { calls.push({ file, args, options, done }); if (throws) throw new Error('spawn failed'); } });
  t.after(() => subject.close());
  return { subject, calls, emitted, startedWhile, setKnown: (list: typeof known) => { known = list; }, setOnline: (value: boolean) => { online = value; }, advance: (ms: number) => { now += ms; subject.tick(now); } };
}
test('the module answers 404, 409 and 202 and runs a command only for 202', t => {
  const m = module(t);
  assert.deepEqual(m.subject.start(machines[0], 'missing', 'connect'), { status: 404 });
  assert.deepEqual(m.subject.start(machines[2], vpn.name, 'connect'), { status: 404, message: 'no way to reach this Machine' });
  m.setOnline(false); assert.deepEqual(m.subject.start(machines[0], vpn.name, 'connect'), { status: 409 });
  assert.equal(m.calls.length, 0);
  m.setOnline(true); assert.deepEqual(m.subject.start(machines[0], vpn.name, 'connect'), { status: 202 });
  assert.deepEqual(m.subject.start(machines[0], vpn.name, 'disconnect'), { status: 409 });
  assert.equal(m.calls.length, 1); assert.deepEqual(m.emitted, [{ machine: 'pc', at: 120_000 }]);
});
test('the module announces a started command while it is pending and before it runs, even if it fails at once', t => {
  const m = module(t, true);
  assert.deepEqual(m.subject.start(machines[0], vpn.name, 'disconnect'), { status: 202 });
  assert.deepEqual(m.startedWhile, [{ at: 120_000, calls: 0, pending: 'disconnect' }]);
  assert.equal(m.subject.state('pc', [vpn])[0].pending, null);
});
test('state adds pending and error only to VPNs with a command', t => {
  const m = module(t); const other = { name: 'Other', status: 'connected' };
  assert.deepEqual(m.subject.state('pc', [vpn, other]), [vpn, other]);
  m.subject.start(machines[0], vpn.name, 'connect');
  assert.deepEqual(m.subject.state('pc', [vpn, other]), [{ ...vpn, pending: { action: 'connect', since: '1970-01-01T00:02:00.000Z' }, error: null }, other]);
  assert.deepEqual(m.subject.state('mac', [vpn]), [vpn]);
});
test('reconcile returns a disconnect the report completed, once, and settles connects and vanished VPNs without it', t => {
  const m = module(t);
  m.subject.start(machines[0], vpn.name, 'disconnect');
  assert.deepEqual(m.subject.reconcile(machines[0], undefined), []);
  assert.deepEqual(m.subject.reconcile(machines[0], [{ ...vpn, status: 'disconnecting' }]), []);
  assert.deepEqual(m.subject.reconcile(machines[0], [vpn]), [{ machine: 'pc', vpn: vpn.name }]);
  assert.equal(m.subject.state('pc', [vpn])[0].pending, null);
  assert.deepEqual(m.subject.reconcile(machines[0], [vpn]), []);
  m.subject.start(machines[0], vpn.name, 'connect');
  assert.deepEqual(m.subject.reconcile(machines[0], [{ ...vpn, status: 'connected' }]), []);
  assert.equal(m.subject.state('pc', [vpn])[0].pending, null);
  m.subject.start(machines[0], vpn.name, 'disconnect');
  assert.deepEqual(m.subject.reconcile(machines[0], []), []);
  assert.deepEqual(m.subject.state('pc', [vpn]), [vpn]);
});
test('a disconnect that failed is not reported as completed when a later report shows it disconnected', t => {
  const m = module(t);
  m.subject.start(machines[0], vpn.name, 'disconnect'); m.calls[0].done({ code: 1 }, '', 'refused');
  assert.deepEqual(m.subject.reconcile(machines[0], [vpn]), []);
});
test('tick expires a command after 90 seconds and emits once', t => {
  const m = module(t); m.subject.start(machines[0], vpn.name, 'connect');
  m.advance(89_999); assert.equal(m.emitted.length, 1);
  m.advance(1); assert.equal(m.emitted.length, 2);
  assert.deepEqual(m.subject.state('pc', [vpn])[0].error, { message: 'No change after 90 s', at: '1970-01-01T00:03:30.000Z' });
  m.advance(5000); assert.equal(m.emitted.length, 2);
});
test('Windows command encodes typographic quotes as UTF-8 data', t => {
  const m = module(t); const name = "x’; Write-Output INJECTED; ‘";
  m.setKnown([{ ...vpn, name }]);
  m.subject.start(machines[0], name, 'connect');
  const source = Buffer.from(m.calls[0].args.at(-1)!, 'base64').toString('utf16le');
  assert.equal(source.includes(name), false);
  assert.equal(source.includes(Buffer.from(name, 'utf8').toString('base64')), true);
});
test('Windows command errors preserve accents and discard CLIXML records', t => {
  const m = module(t); m.subject.start(machines[0], vpn.name, 'connect');
  m.calls[0].done({ code: 1 }, '', 'Não foi possível conectar.\r\n#< CLIXML\n<Objs Version="1.1.0.1">garbage</Objs>\n');
  assert.equal(m.subject.state('pc', [vpn])[0].error.message, 'Não foi possível conectar.');
});
test('close forgets commands and a late callback does nothing', t => {
  const m = module(t); m.subject.start(machines[0], vpn.name, 'connect');
  m.subject.close();
  assert.doesNotThrow(() => m.calls[0].done({ code: 1 }, '', 'late failure'));
  assert.equal(m.emitted.length, 1); assert.deepEqual(m.subject.state('pc', [vpn]), [vpn]);
});
