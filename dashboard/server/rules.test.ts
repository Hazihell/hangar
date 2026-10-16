import { test } from 'node:test';
import assert from 'node:assert/strict';
import { online, minute, average, percentages, validReport } from './rules.ts';
import { Store } from './store.ts';
const report = { machine: 'pc', cpu: 20, ram: { used: 25, total: 100 }, disks: [{ name: 'C:', used: 20, total: 100 }, { name: 'D:', used: 90, total: 100 }] };
test('Online ends exactly 30 seconds after arrival; unseen Machines are Offline', () => {
  assert.equal(online(1000, 30_999), true); assert.equal(online(1000, 31_000), false); assert.equal(online(null, 0), false);
});
test('minute buckets and running averages use all reports and fullest disk', () => {
  assert.equal(minute(119_999), 60_000); assert.equal(minute(120_000), 120_000);
  assert.deepEqual(percentages(report), { cpu: 20, ram: 25, disk: 90 });
  const first = average(undefined, report);
  const second = average(first, { ...report, cpu: 80, ram: { used: 75, total: 100 }, disks: [] });
  assert.deepEqual(second, { cpu: 50, ram: 50, disk: 45, count: 2 });
  assert.equal(average(second, { ...report, cpu: 20 }).cpu, 40);
});
test('24 hour cutoff retains its boundary', () => {
  const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
  const store = new Store(':memory:', [machine]);
  try {
    store.intake(report, 0);
    store.prune(86_400_000);
    assert.deepEqual(store.snapshot(machine, 86_400_000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 20, ram: 25, disk: 90 }]);
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
      { t: '1970-01-01T00:01:00.000Z', cpu: 50, ram: 25, disk: 90 },
      { t: '1970-01-01T00:02:00.000Z', cpu: 90, ram: 25, disk: 90 },
    ]);
    assert.deepEqual(store.event(machine, 180_000).minute, null);
  } finally { store.close(); }
});
