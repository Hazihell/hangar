import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuit } from './quit.ts';
import type { Local } from './quit.ts';
const pc = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
const mac = { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' };
const p = { pid: 5000, name: 'node', app: 'node', cpu: 1, ram: 2, started: '123', own: true };
const forbidden = () => { throw new Error('must not reach execution'); };
function setup(extra: Partial<Parameters<typeof createQuit>[0]> = {}, reports: Record<string, any> = {}) {
  const signals: [number, string][] = [];
  const local: Local = { uid: 1000, read: pid => ({ pid, name: 'node', started: pid >= 6000 ? `s${pid - 6000}` : '123', uid: 1000 }) as any, quit: (pid, signal) => { signals.push([pid, signal]); } };
  const quit = createQuit({ processes: id => reports[id], online: () => true, exec: forbidden as any, local, mainPid: async () => 1, watch: false, ...extra });
  return { quit, signals };
}
test('a Machine that cannot be reached is 404 and an Offline one 409, before anything runs', async () => {
  const { quit } = setup({ online: m => m.id !== 'mac' }, { pc: { processes: [p] } });
  try {
    const request = { targets: [{ pid: p.pid, started: p.started }], force: false };
    assert.deepEqual(await quit.handle(undefined, request), { status: 404 });
    assert.deepEqual(await quit.handle({ ...mac, ssh: undefined }, request), { status: 404 });
    assert.deepEqual(await quit.handle(mac, request), { status: 409 });
  } finally { quit.close(); }
});
test('an App is expanded to the Processes of it that may be quit, beyond the twenty a report lists, each result naming its identity', async () => {
  const processes = Array.from({ length: 25 }, (_, i) => ({ ...p, pid: 6000 + i, started: `s${i}`, own: i !== 3 }));
  const { quit, signals } = setup({}, { pc: { wsl: processes } });
  try {
    const outcome = await quit.handle(pc, { app: 'node', where: 'wsl', force: false });
    assert.equal(outcome.status, 200);
    const results = (outcome as any).results;
    assert.equal(results.length, 24); assert.equal(signals.length, 24);
    assert.ok(results.every((r: any) => r.result === 'sent' && r.where === 'wsl' && r.started === `s${r.pid - 6000}`));
    assert.ok(!results.some((r: any) => r.pid === 6003));
  } finally { quit.close(); }
});
test('a WSL Quit protects the T3 service Process as it is when the Quit comes, and is refused if that cannot be told', async () => {
  let current: number | null = 0;
  const { quit, signals } = setup({ mainPid: async () => current }, { pc: { wsl: [p] } });
  try {
    const request = { app: 'node', where: 'wsl' as const, force: false };
    current = p.pid;
    assert.deepEqual(await quit.handle(pc, request), { status: 200, results: [] });
    assert.equal(quit.protection.t3, p.pid);
    for (const bad of [null, -1, 1.5]) {
      current = bad;
      assert.equal((await quit.handle(pc, request)).status, 503);
    }
    assert.deepEqual(signals, []);
  } finally { quit.close(); }
});
test('watching refreshes the protected T3 Process every thirty seconds, keeping the last one when it cannot be told', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  let current: () => Promise<number | null> = async () => 42;
  const { quit } = setup({ watch: true, mainPid: () => current() });
  try {
    await settle();
    assert.equal(quit.protection.t3, 42);
    current = async () => 43; t.mock.timers.tick(30_000); await settle();
    assert.equal(quit.protection.t3, 43);
    current = async () => null; t.mock.timers.tick(30_000); await settle();
    assert.equal(quit.protection.t3, 43);
    current = async () => { throw new Error('systemctl missing'); }; t.mock.timers.tick(30_000); await settle();
    assert.equal(quit.protection.t3, 43);
    current = async () => 44; t.mock.timers.tick(30_000); await settle();
    assert.equal(quit.protection.t3, 44);
  } finally { quit.close(); }
});
test('without watching, T3 is only looked up when a WSL Quit comes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const { quit } = setup({ watch: false, mainPid: async () => { calls++; return 7; } });
  try {
    t.mock.timers.tick(90_000); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 0); assert.equal(quit.protection.t3, undefined);
  } finally { quit.close(); }
});
