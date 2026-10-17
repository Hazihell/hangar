import { test } from 'node:test';
import assert from 'node:assert/strict';
import { online, minute, average, percentages, validReport } from './rules.ts';
import { Store } from './store.ts';
import { DatabaseSync } from 'node:sqlite';
const report = { machine: 'pc', cpu: 20, ram: { used: 25, total: 100 }, disks: [{ name: 'C:', used: 20, total: 100 }, { name: 'D:', used: 90, total: 100 }] };
test('Online ends exactly 30 seconds after arrival; unseen Machines are Offline', () => {
  assert.equal(online(1000, 30_999), true); assert.equal(online(1000, 31_000), false); assert.equal(online(null, 0), false);
});
test('minute buckets and running averages use all reports and fullest disk', () => {
  assert.equal(minute(119_999), 60_000); assert.equal(minute(120_000), 120_000);
  assert.deepEqual(percentages(report), { cpu: 20, ram: 25, disk: 90 });
  const first = average(undefined, report);
  const second = average(first, { ...report, cpu: 80, ram: { used: 75, total: 100 }, disks: [] });
  assert.deepEqual(second, { cpu: 50, ram: 50, disk: 45, count: 2, temp: null, tcount: 0 });
  assert.equal(average(second, { ...report, cpu: 20 }).cpu, 40);
});
test('24 hour cutoff retains its boundary', () => {
  const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
  const store = new Store(':memory:', [machine]);
  try {
    store.intake(report, 0);
    store.prune(86_400_000);
    assert.deepEqual(store.snapshot(machine, 86_400_000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 20, ram: 25, disk: 90, temp: null }]);
    store.prune(86_400_001);
    assert.deepEqual(store.snapshot(machine, 86_400_001).history, []);
  } finally { store.close(); }
});
test('validation rejects malformed Usage and accepts optional services', () => {
  assert.equal(validReport(report), true); assert.equal(validReport({ ...report, services: { t3: false } }), true);
  for (const value of [null, [], {}, { ...report, machine: '' }, { ...report, cpu: -1 }, { ...report, cpu: 101 }, { ...report, cpu: NaN }, { ...report, ram: { used: 101, total: 100 } }, { ...report, ram: { used: 0, total: 0 } }, { ...report, disks: [{ name: '', used: 0, total: 1 }] }, { ...report, services: { t3: 'yes' } }]) assert.equal(validReport(value), false);
});
test('Last seen uses arrival time, history prunes and survives restart', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hangar-store-')); t.after(() => rmSync(dir, { recursive: true }));
  const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
  let store = new Store(join(dir, 'test.db'), [machine]);
  assert.equal(store.snapshot(machine, 0).lastSeen, null);
  store.intake(report, 1234); store.intake({ ...report, cpu: 80 }, 2000);
  assert.equal(store.snapshot(machine, 2000).lastSeen, '1970-01-01T00:00:02.000Z');
  assert.equal(store.snapshot(machine, 2000).history[0].cpu, 50);
  store.close(); store = new Store(join(dir, 'test.db'), [machine]);
  try {
    assert.equal(store.snapshot(machine, 2000).usage?.cpu, 80);
    store.prune(86_400_001); assert.deepEqual(store.snapshot(machine, 86_400_001).history, []);
    assert.equal(store.snapshot(machine, 86_400_001).lastSeen, '1970-01-01T00:00:02.000Z');
  } finally { store.close(); }
});

test('Store keeps separate averages across a two-minute rollover', () => {
  const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
  const store = new Store(':memory:', [machine]);
  try {
    store.intake(report, 119_998);
    store.intake({ ...report, cpu: 80 }, 119_999);
    store.intake({ ...report, cpu: 90 }, 120_000);
    assert.deepEqual(store.snapshot(machine, 120_000).history, [
      { t: '1970-01-01T00:01:00.000Z', cpu: 50, ram: 25, disk: 90, temp: null },
      { t: '1970-01-01T00:02:00.000Z', cpu: 90, ram: 25, disk: 90, temp: null },
    ]);
    assert.deepEqual(store.event(machine, 180_000).minute, null);
  } finally { store.close(); }
});
test('validation keeps a Temperature in range, drops one that is not, and treats no readings as no temps', () => {
  const check = (temps: unknown) => { const r: any = { ...report, temps }; return validReport(r) ? r.temps : false; };
  assert.deepEqual(check({ cpu: 49.5, gpu: 38 }), { cpu: 49.5, gpu: 38 });
  assert.deepEqual(check({ cpu: -20, gpu: 150 }), { cpu: -20, gpu: 150 });
  assert.deepEqual(check({ cpu: 151, gpu: 38 }), { gpu: 38 });
  assert.deepEqual(check({ cpu: 'hot', gpu: -21, other: 5 }), undefined);
  assert.deepEqual(check({ cpu: null, gpu: NaN }), undefined);
  assert.deepEqual(check({}), undefined);
  for (const bad of [null, [], 'hot', 5]) assert.equal(check(bad), false, JSON.stringify(bad));
  const r: any = { ...report, temps: {} }; validReport(r); assert.equal('temps' in r, false);
});
test('a minute averages the CPU temperature of only the reports that had one', () => {
  assert.equal(average(undefined, report).temp, null);
  const first = average(undefined, { ...report, temps: { cpu: 60, gpu: 30 } });
  assert.deepEqual([first.temp, first.tcount], [60, 1]);
  const second = average(first, report);
  assert.deepEqual([second.temp, second.tcount, second.count], [60, 1, 2]);
  const third = average(second, { ...report, temps: { cpu: 80 } });
  assert.deepEqual([third.temp, third.tcount], [70, 2]);
  const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
  const store = new Store(':memory:', [machine]);
  try {
    store.intake(report, 1000); store.intake({ ...report, temps: { cpu: 60 } }, 2000); store.intake({ ...report, temps: { cpu: 80 } }, 3000); store.intake(report, 4000);
    store.intake(report, 60_000);
    assert.deepEqual(store.snapshot(machine, 60_000).history.map(p => p.temp), [70, null]);
    assert.deepEqual(store.snapshot(machine, 60_000).usage?.temps, undefined);
    store.intake({ ...report, temps: { cpu: 90, gpu: 50 } }, 61_000);
    assert.deepEqual(store.snapshot(machine, 61_000).usage?.temps, { cpu: 90, gpu: 50 });
    assert.equal(store.event(machine, 61_000).minute?.temp, 90);
  } finally { store.close(); }
});
test('a History table from before Temperatures gains its columns and keeps its points', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hangar-store-')); t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'old.db'), machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE history (machine TEXT, t INTEGER, cpu REAL, ram REAL, disk REAL, count INTEGER, PRIMARY KEY(machine,t)); INSERT INTO history VALUES (\'pc\', 0, 20, 25, 90, 3)');
  old.close();
  const store = new Store(file, [machine]);
  try {
    assert.deepEqual(store.snapshot(machine, 1000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 20, ram: 25, disk: 90, temp: null }]);
    store.intake({ ...report, temps: { cpu: 60 } }, 1000);
    assert.deepEqual(store.snapshot(machine, 1000).history.map(p => [p.cpu, p.temp]), [[(20 * 3 + 20) / 4, 60]]);
  } finally { store.close(); }
});
