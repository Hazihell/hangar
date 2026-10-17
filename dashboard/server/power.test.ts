import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from './server.ts';
import type { Exec } from './vpn.ts';

const machines = [
  { id: 'pc', name: 'Stormtrooper', os: 'windows', collector: 'wsl' },
  { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' },
];
async function fixture(t: any, throws = false) {
  let now = 120_000;
  const calls: { file: string; args: string[]; options: { timeout: number }; done: Parameters<Exec>[3] }[] = [];
  const app = createDashboard({ db: ':memory:', machines, collect: false, clock: () => now, hosts: [],
    exec(file, args, options, done) { calls.push({ file, args, options, done }); if (throws) throw new Error('Command failed: secret command line'); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.listening ? app.close() : undefined);
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = (id: string, body: unknown = { action: 'sleep' }, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => fetch(`${base}/api/machines/${id}/power`, { method: 'POST', headers, body: JSON.stringify(body) });
  const report = () => fetch(base + '/api/report', { method: 'POST', body: JSON.stringify({ machine: 'pc', cpu: 10, ram: { used: 1, total: 2 }, disks: [] }) });
  const get = async (id = 'pc') => (await (await fetch(base + '/api/machines')).json()).machines.find((m: any) => m.id === id);
  const advance = (ms: number) => { now += ms; app.tick(); };
  return { app, base, post, report, get, calls, advance, jump: (ms: number) => { now += ms; } };
}

test('power endpoint guards malformed, unsupported, Offline, pending and cross-origin requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('pc')).status, 409);
  assert.equal((await f.post('mac')).status, 404);
  assert.equal((await f.post('missing')).status, 404);
  assert.equal('power' in await f.get('mac'), false);
  for (const body of [null, {}, { action: 'hibernate' }, { action: 1 }, ['sleep']]) assert.equal((await f.post('pc', body)).status, 400);
  assert.equal((await f.post('pc', { action: 'sleep' }, {})).status, 400);
  assert.equal((await f.post('pc', { action: 'sleep' }, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await fetch(f.base + '/api/machines/pc/power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.post('pc', { action: 'sleep' }, { 'Content-Type': 'application/json', Origin: 'https://attacker.example' })).status, 403);
  await f.report();
  assert.deepEqual((await f.get()).power, { actions: ['sleep', 'shutdown'], pending: null, error: null });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal((await f.post('pc')).status, 202);
  assert.equal((await f.post('pc', { action: 'shutdown' })).status, 409);
  assert.equal(f.calls.length, 0);
});

for (const action of ['sleep', 'shutdown']) test(`${action} publishes pending before running the exact Windows command after 1.5 seconds`, async t => {
  const f = await fixture(t); await f.report();
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(f.base + '/api/events', { signal: abort.signal });
  const reader = stream.body!.getReader(); await reader.read();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = await f.post('pc', { action });
  assert.equal(response.status, 202);
  const expected = { actions: ['sleep', 'shutdown'], pending: { action, since: '1970-01-01T00:02:00.000Z' }, error: null };
  assert.deepEqual(await response.json(), expected);
  const event = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1].trim());
  assert.deepEqual(event.power, expected);
  t.mock.timers.tick(1499); assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.deepEqual(call.options, { timeout: 0, encoding: 'utf8' });
  if (action === 'sleep') {
    assert.equal(call.file, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    assert.deepEqual(call.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(Buffer.from(call.args.at(-1)!, 'base64').toString('utf16le'), "Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)) { exit 1 }");
  } else {
    assert.equal(call.file, '/mnt/c/Windows/System32/shutdown.exe');
    assert.deepEqual(call.args, ['/s', '/t', '0']);
  }
  call.done(null, '', ''); assert.deepEqual((await f.get()).power, action === 'sleep' ? { ...expected, pending: null } : expected);
  await reader.cancel();
});

test('power failures publish a short error that survives reports and clears on retry', async t => {
  const f = await fixture(t); await f.report();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.post('pc'); t.mock.timers.tick(1500);
  f.calls[0].done({ code: 1 }, '', '\u0001Access denied\r\nprivate details');
  assert.deepEqual((await f.get()).power.error, { message: 'Access denied', at: '1970-01-01T00:02:00.000Z' });
  assert.equal((await f.get()).power.pending, null);
  await f.report(); assert.equal((await f.get()).power.error.message, 'Access denied');
  await f.post('pc'); assert.equal((await f.get()).power.error, null);
  f.calls[0].done({ code: 1 }, '', 'late old failure');
  assert.ok((await f.get()).power.pending);
});

test('synchronous power spawn failures never expose the exec command line', async t => {
  const f = await fixture(t, true); await f.report();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.post('pc'); t.mock.timers.tick(1500);
  assert.equal((await f.get()).power.error.message, 'Power command failed (exit code 1)');
});

for (const action of ['sleep', 'shutdown']) test(`${action} times out after two minutes of uninterrupted server ticks`, async t => {
  const f = await fixture(t); await f.report();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.post('pc', { action }); t.mock.timers.tick(1500);
  for (let i = 0; i < 23; i++) f.advance(5000);
  assert.ok((await f.get()).power.pending);
  f.advance(5000);
  const power = (await f.get()).power;
  assert.equal(power.pending, null);
  assert.equal(power.error.message, action === 'sleep' ? "Stormtrooper didn't go to sleep" : "Stormtrooper didn't shut down — an app may have blocked it");
});

test('resume clears pending without error even when the command callback arrives before the next tick', async t => {
  const f = await fixture(t); await f.report();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.post('pc'); t.mock.timers.tick(1500);
  f.jump(3600_000);
  f.calls[0].done({ code: 1 }, '', 'late failure');
  assert.equal((await f.get()).power.error, null);
  assert.equal((await f.get()).power.pending, null);
  await f.report(); await f.post('pc'); t.mock.timers.tick(1500);
  await f.app.close();
  assert.doesNotThrow(() => f.calls[1].done({ code: 1 }, '', 'closed'));
});

test('power errors, timeouts and resume publish machine events; resume also cancels an unstarted command', async t => {
  const f = await fixture(t); await f.report();
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(f.base + '/api/events', { signal: abort.signal });
  const reader = stream.body!.getReader(); await reader.read();
  const event = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1].trim());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.post('pc'); await event(); t.mock.timers.tick(1500);
  f.calls[0].done({ code: 1 }, '', 'Cannot suspend');
  assert.equal((await event()).power.error.message, 'Cannot suspend');
  await f.post('pc'); await event(); t.mock.timers.tick(1500);
  // Keep reports fresh so only the power timeout produces another event.
  for (let i = 0; i < 23; i++) { f.advance(5000); await f.report(); await event(); }
  f.advance(5000);
  assert.equal((await event()).power.error.message, "Stormtrooper didn't go to sleep");
  await f.report(); await event(); await f.post('pc'); await event();
  f.advance(36_000);
  const resumed = await event();
  assert.equal(resumed.power.pending, null);
  assert.equal(resumed.power.error, null);
  t.mock.timers.tick(1500);
  assert.equal(f.calls.length, 2, 'the queued command must not suspend the PC again after resume');
  await reader.cancel();
});

test('a sleep command returning success counts as resume even when the clock did not jump', async t => {
  const f = await fixture(t); await f.report();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal((await f.post('pc')).status, 202);
  t.mock.timers.tick(1500);
  f.calls[0].done(null, '', '');
  assert.deepEqual((await f.get()).power, { actions: ['sleep', 'shutdown'], pending: null, error: null });
});

test('a late sleep return after resume leaves a newer power command alone', async t => {
  const f = await fixture(t); await f.report();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.post('pc'); t.mock.timers.tick(1500);
  f.jump(60_000); f.advance(5000); await f.report();
  assert.equal((await f.post('pc', { action: 'shutdown' })).status, 202);
  f.calls[0].done(null, '', '');
  assert.equal((await f.get()).power.pending.action, 'shutdown');
  t.mock.timers.tick(1500);
  assert.deepEqual(f.calls[1].args, ['/s', '/t', '0']);
});
