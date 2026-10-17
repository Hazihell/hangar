import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from './server.ts';
import { Store } from './store.ts';
import { validReport, validQuit } from './rules.ts';
const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
const report = { machine: 'pc', cpu: 10, ram: { used: 1, total: 2 }, disks: [] };
const p = { pid: 10, name: 'chrome.exe', app: 'Chrome', cpu: 50, ram: 100, started: '123', own: true };
async function setup(t: any, extra: any = {}) {
  const app = createDashboard({ db: ':memory:', machines: [machine], collect: false, ...extra });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${(app.server.address() as any).port}` };
}
test('requests reject rebinding Host; mutations also reject and cross-origin browser requests before handling any endpoint', async t => {
  const { base } = await setup(t, { hosts: ['pc.example.ts.net', 'localhost:5173'] });
  const send = (path: string, headers: any, method = 'POST', body = '{}') => new Promise<{ status: number }>((resolve, reject) => {
    const req = request(base + path, { method, agent: false, headers: { 'content-length': Buffer.byteLength(body), ...headers } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode! })); });
    req.on('error', reject); req.end(body);
  });
  for (const path of ['/api/report', '/api/machines/pc/quit', '/api/machines/pc/vpns/a', '/api/alerts/subscriptions', '/api/alerts/test', '/unknown']) {
    assert.equal((await send(path, { host: 'evil.example' })).status, 403, path);
  }
  assert.equal((await send('/api/alerts/subscriptions', { host: 'evil.example' }, 'DELETE')).status, 403);
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: base + '/path' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await send('/api/alerts/test', headers)).status, 403);
  }
  for (const headers of [{ origin: base }, { host: 'pc.example.ts.net', origin: 'https://pc.example.ts.net' }, { origin: 'http://localhost:5173' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'same-origin' }]) {
    assert.equal((await send('/api/alerts/test', headers)).status, 400);
  }
  assert.equal((await send('/api/alerts/test', { origin: 'http://pc.example.ts.net' })).status, 403);
  // The non-browser reporter needs no Origin, but still needs an allowed Host.
  assert.equal((await send('/api/report', { host: 'pc.example.ts.net' }, 'POST', JSON.stringify(report))).status, 204);
  // Reads too: a rebinding page must not see Process lists or started tokens.
  for (const path of ['/api/machines', '/api/events', '/']) assert.equal((await send(path, { host: 'evil.example' }, 'GET', '')).status, 403, path);
  assert.equal((await send('/api/machines', {}, 'GET', '')).status, 200);
});
test('bad Process rows are dropped without losing valid Usage or healthy rows', async t => {
  const { base } = await setup(t);
  const value = { ...report, processes: [p, { ...p, pid: 11, name: 'bad\tname' }, null], wsl: [{ ...p, ram: -1 }] };
  assert.equal((await fetch(base + '/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 204);
  const state = (await (await fetch(base + '/api/machines')).json()).machines[0];
  assert.equal(state.online, true); assert.equal(state.usage.cpu, 10);
  assert.equal(state.apps.list[0].count, 1); assert.equal(state.apps.list[0].cpu, 50);
  assert.equal(validReport({ ...report, cpu: -1, processes: [p] }), false);
  assert.equal(validReport({ ...report, processes: {} }), false);
});
test('app-wide Quit resolves every quittable Process beyond the display cap with latest tokens', async t => {
  const calls: any[] = [];
  const { base } = await setup(t, { exec: (_file: string, args: string[], _options: any, done: any) => {
    calls.push(args); done(null, '[]', '');
  } });
  const processes = Array.from({ length: 25 }, (_, i) => ({ ...p, pid: i + 10, started: String(i) }));
  await fetch(base + '/api/report', { method: 'POST', body: JSON.stringify({ ...report, processes: [...processes, { ...p, pid: 100, own: false }] }) });
  const display = (await (await fetch(base + '/api/machines')).json()).machines[0].apps.list[0];
  assert.equal(display.processes.length, 20);
  const result = await fetch(base + '/api/machines/pc/quit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'Chrome', force: false }) });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).results.map((r: any) => r.pid), processes.map(p => p.pid));
  assert.ok(calls.length);
  assert.equal(validQuit({ app: 'Chrome', force: true }), true);
  for (const value of [{ app: '', force: true }, { app: 'Chrome', where: 'mac', force: true }, { app: 'Chrome', targets: [{ pid: 1, started: 'a' }], force: true }]) assert.equal(validQuit(value), false);
});
test('minute App averages ignore reports without Processes but count explicit empty samples', () => {
  const store = new Store(':memory:', [machine]);
  try {
    store.intake({ ...report, processes: [p] }, 1);
    store.intake(report, 2);
    assert.equal(store.topApps('pc', new Date(0).toISOString(), 2)!.apps[0].cpu, 50);
    store.intake({ ...report, processes: [] }, 3);
    assert.equal(store.topApps('pc', new Date(0).toISOString(), 3)!.apps[0].cpu, 25);
    assert.equal(store.snapshot(machine, 3).history[0].cpu, 10);
  } finally { store.close(); }
});
test('minute storage bounds retained Apps to thirty by combined CPU and RAM rank', () => {
  const store = new Store(':memory:', [machine]);
  try {
    store.intake({ ...report, processes: Array.from({ length: 80 }, (_, i) => ({ ...p, pid: i + 1, app: String(i), cpu: i, ram: 80 - i })) }, 1);
    const row = store.db.prepare('SELECT sums FROM top_apps').get() as any;
    assert.equal(JSON.parse(row.sums).length, 30);
    const names = store.topApps('pc', new Date(0).toISOString(), 1)!.apps.map((a: any) => a.name);
    assert.ok(names.includes('0')); assert.ok(names.includes('79')); assert.equal(names.includes('40'), false);
  } finally { store.close(); }
});

test('minute leaders retain earlier contributions even when outside the persisted thirty after a sample', () => {
  const store = new Store(':memory:', [machine]);
  try {
    const leaders = Array.from({ length: 30 }, (_, i) => ({ ...p, pid: 100 + i, app: String(i), cpu: i < 15 ? 21 : 0, ram: i < 15 ? 0 : 21 }));
    const steady = { ...p, app: 'steady', cpu: 20, ram: 20 };
    store.intake({ ...report, processes: [...leaders, steady] }, 1);
    store.intake({ ...report, processes: [steady] }, 2);
    assert.deepEqual(store.topApps('pc', new Date(0).toISOString(), 2)!.apps.find((a: any) => a.name === 'steady'), { name: 'steady', cpu: 20, ram: 20 });
  } finally { store.close(); }
});
test('WSL App Quit resolves beyond twenty and protects a restarted T3 MainPID at action time', async t => {
  let current = 0;
  const signals: number[] = [];
  const processes = Array.from({ length: 25 }, (_, i) => ({ ...p, pid: 1000000 + i, name: 'node', app: 'node' }));
  const { base } = await setup(t, { mainPid: async () => current, local: { uid: 1000, read: (pid: number) => ({ pid, name: 'node', started: '123', uid: 1000 }), quit: (pid: number) => signals.push(pid) } });
  const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  await post('/api/report', { ...report, wsl: processes });
  const first = await post('/api/machines/pc/quit', { app: 'node', where: 'wsl', force: false });
  assert.equal(first.status, 200); assert.equal((await first.json()).results.length, 25); assert.equal(signals.length, 25);
  signals.length = 0;
  current = processes[0].pid; // A service restart after the report must protect the new MainPID.
  const restarted = await post('/api/machines/pc/quit', { targets: [{ pid: current, started: '123', where: 'wsl' }], force: true });
  assert.equal((await restarted.json()).results[0].result, 'protected'); assert.deepEqual(signals, []);
  current = -1;
  assert.equal((await post('/api/machines/pc/quit', { app: 'node', where: 'wsl', force: false })).status, 503);
  assert.deepEqual(signals, []);
});
