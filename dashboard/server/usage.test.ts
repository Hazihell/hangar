import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.ts';
import { Usage, acceptReport } from './usage.ts';
const machine = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
const report = { machine: 'pc', cpu: 20, ram: { used: 25, total: 100 }, disks: [{ name: 'C:', used: 20, total: 100 }, { name: 'D:', used: 90, total: 100 }] };
const p = { pid: 10, name: 'chrome.exe', app: 'Chrome', cpu: 5, ram: 100, started: 'token', own: true };
function open(file = ':memory:') {
  const store = new Store(file), usage = new Usage(store.db, [machine]);
  return { usage, close: () => store.close() };
}
/** Accepts a report at `now` and expects it to have been recorded. */
function take(usage: Usage, value: unknown, now: number) {
  const result = usage.intake(value, now);
  assert.equal(result.status, 204);
  return result;
}
test('a report is rejected as malformed, or from an unknown Machine, and records nothing', () => {
  const { usage, close } = open();
  try {
    for (const value of [null, [], {}, { ...report, machine: '' }, { ...report, cpu: -1 }, { ...report, cpu: 101 }, { ...report, cpu: NaN }, { ...report, ram: { used: 101, total: 100 } }, { ...report, ram: { used: 0, total: 0 } }, { ...report, disks: [{ name: '', used: 0, total: 1 }] }, { ...report, services: { t3: 'yes' } }, { ...report, temps: 'hot' }]) {
      assert.equal(usage.intake(value, 1).status, 400, JSON.stringify(value));
    }
    assert.equal(usage.intake({ ...report, machine: 'unknown' }, 1).status, 404);
    assert.equal(usage.snapshot(machine, 1).usage, null);
    assert.deepEqual(usage.snapshot(machine, 1).history, []);
  } finally { close(); }
});
test('an accepted report comes back normalised, without fields it does not know, and the input is left alone', () => {
  const { usage, close } = open();
  try {
    const input = { ...report, at: 'untrusted client clock', services: { t3: false }, vpns: [{ name: 'Steeprock', status: 'connected', kind: 'ppp', extra: 1 }], disks: [{ ...report.disks[0], free: 80 }] };
    const before = structuredClone(input);
    const result = take(usage, input, 1);
    assert.deepEqual(input, before);
    assert.deepEqual(result.status === 204 && result.report, { ...report, disks: [report.disks[0]], services: { t3: false }, vpns: [{ name: 'Steeprock', status: 'connected', kind: 'ppp' }] });
    assert.equal(result.status === 204 && result.machine, machine);
  } finally { close(); }
});
test('acceptReport answers with a new value: bad Process rows and out-of-range Temperatures are dropped alone, and the input is not touched', () => {
  const rows = [p, { ...p, pid: 0 }, null, { ...p, name: 'bad\tname' }];
  const input = { ...report, processes: rows, wsl: [{ ...p, ram: -1 }], temps: { cpu: 151, gpu: 38, other: 5 } };
  const before = structuredClone(input);
  const accepted = acceptReport(input)!;
  assert.deepEqual(accepted.processes, [p]); assert.deepEqual(accepted.wsl, []); assert.deepEqual(accepted.temps, { gpu: 38 });
  assert.deepEqual(input, before);
  assert.equal(accepted.processes === rows, false);
});
test('acceptReport keeps a Temperature in range, drops one that is not, and treats no readings as no temps', () => {
  const check = (temps: unknown) => { const r = acceptReport({ ...report, temps }); return r ? r.temps : false; };
  assert.deepEqual(check({ cpu: 49.5, gpu: 38 }), { cpu: 49.5, gpu: 38 });
  assert.deepEqual(check({ cpu: -20, gpu: 150 }), { cpu: -20, gpu: 150 });
  assert.deepEqual(check({ cpu: 151, gpu: 38 }), { gpu: 38 });
  assert.deepEqual(check({ cpu: 'hot', gpu: -21, other: 5 }), undefined);
  assert.deepEqual(check({ cpu: null, gpu: NaN }), undefined);
  assert.deepEqual(check({}), undefined);
  for (const bad of [null, [], 'hot', 5]) assert.equal(check(bad), false, JSON.stringify(bad));
  assert.equal('temps' in acceptReport({ ...report, temps: {} })!, false);
});
test('minute buckets average every report, with the fullest disk', () => {
  const { usage, close } = open();
  try {
    take(usage, report, 1000);
    assert.deepEqual(usage.snapshot(machine, 1000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 20, ram: 25, disk: 90, temp: null }]);
    take(usage, { ...report, cpu: 80, ram: { used: 75, total: 100 }, disks: [] }, 2000);
    assert.deepEqual(usage.snapshot(machine, 2000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 50, ram: 50, disk: 45, temp: null }]);
    take(usage, { ...report, cpu: 20 }, 3000);
    assert.equal(usage.snapshot(machine, 3000).history[0].cpu, 40);
  } finally { close(); }
});
test('24 hour cutoff retains its boundary', () => {
  const { usage, close } = open();
  try {
    take(usage, report, 0);
    usage.prune(86_400_000);
    assert.deepEqual(usage.snapshot(machine, 86_400_000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 20, ram: 25, disk: 90, temp: null }]);
    usage.prune(86_400_001);
    assert.deepEqual(usage.snapshot(machine, 86_400_001).history, []);
  } finally { close(); }
});
test('Last seen uses arrival time, history prunes and survives restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-usage-')); t.after(() => rmSync(dir, { recursive: true }));
  let { usage, close } = open(join(dir, 'test.db'));
  assert.equal(usage.snapshot(machine, 0).lastSeen, null);
  take(usage, report, 1234); take(usage, { ...report, cpu: 80 }, 2000);
  assert.equal(usage.snapshot(machine, 2000).lastSeen, '1970-01-01T00:00:02.000Z');
  assert.equal(usage.snapshot(machine, 2000).history[0].cpu, 50);
  close(); ({ usage, close } = open(join(dir, 'test.db')));
  try {
    assert.equal(usage.snapshot(machine, 2000).usage?.cpu, 80);
    usage.prune(86_400_001); assert.deepEqual(usage.snapshot(machine, 86_400_001).history, []);
    assert.equal(usage.snapshot(machine, 86_400_001).lastSeen, '1970-01-01T00:00:02.000Z');
  } finally { close(); }
});
test('Usage keeps separate averages across a two-minute rollover', () => {
  const { usage, close } = open();
  try {
    take(usage, report, 119_998);
    take(usage, { ...report, cpu: 80 }, 119_999);
    take(usage, { ...report, cpu: 90 }, 120_000);
    assert.deepEqual(usage.snapshot(machine, 120_000).history, [
      { t: '1970-01-01T00:01:00.000Z', cpu: 50, ram: 25, disk: 90, temp: null },
      { t: '1970-01-01T00:02:00.000Z', cpu: 90, ram: 25, disk: 90, temp: null },
    ]);
    assert.deepEqual(usage.event(machine, 180_000).minute, null);
  } finally { close(); }
});
test('a minute averages the CPU temperature of only the reports that had one', () => {
  const { usage, close } = open();
  try {
    take(usage, report, 1000); take(usage, { ...report, temps: { cpu: 60 } }, 2000); take(usage, { ...report, temps: { cpu: 80 } }, 3000); take(usage, report, 4000);
    take(usage, report, 60_000);
    assert.deepEqual(usage.snapshot(machine, 60_000).history.map(p => p.temp), [70, null]);
    assert.deepEqual(usage.snapshot(machine, 60_000).usage?.temps, undefined);
    take(usage, { ...report, temps: { cpu: 90, gpu: 50 } }, 61_000);
    assert.deepEqual(usage.snapshot(machine, 61_000).usage?.temps, { cpu: 90, gpu: 50 });
    assert.equal(usage.event(machine, 61_000).minute?.temp, 90);
  } finally { close(); }
});
test('a History table from before Temperatures gains its columns and keeps its points', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-usage-')); t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE history (machine TEXT, t INTEGER, cpu REAL, ram REAL, disk REAL, count INTEGER, PRIMARY KEY(machine,t)); INSERT INTO history VALUES (\'pc\', 0, 20, 25, 90, 3)');
  old.close();
  const { usage, close } = open(file);
  try {
    assert.deepEqual(usage.snapshot(machine, 1000).history, [{ t: '1970-01-01T00:00:00.000Z', cpu: 20, ram: 25, disk: 90, temp: null }]);
    take(usage, { ...report, temps: { cpu: 60 } }, 1000);
    assert.deepEqual(usage.snapshot(machine, 1000).history.map(p => [p.cpu, p.temp]), [[(20 * 3 + 20) / 4, 60]]);
  } finally { close(); }
});
test('an omitted Process list leaves the last one standing; an empty one replaces it', () => {
  const { usage, close } = open();
  try {
    take(usage, { ...report, processes: [p], reporterPid: 7 }, 1);
    take(usage, report, 2);
    assert.deepEqual(usage.processes('pc')?.processes, [p]); assert.equal(usage.processes('pc')?.reporterPid, 7);
    assert.equal(usage.snapshot(machine, 2).apps?.list[0].name, 'Chrome');
    take(usage, { ...report, processes: [] }, 3);
    assert.deepEqual(usage.processes('pc')?.processes, []);
    assert.equal(usage.processes('pc')?.reporterPid, 7);
    assert.equal(usage.snapshot(machine, 3).apps?.list.length, 0);
  } finally { close(); }
});
test('omitted VPNs leave the known ones standing, and an empty list clears them', () => {
  const { usage, close } = open();
  try {
    const vpn = { name: 'Steeprock', status: 'connected', kind: 'ppp' };
    const kept = take(usage, { ...report, vpns: [vpn] }, 1);
    assert.deepEqual(kept.status === 204 && kept.report.vpns, [vpn]);
    const omitted = take(usage, report, 2);
    assert.equal(omitted.status === 204 && 'vpns' in omitted.report, false); // the reconcile still sees that none were reported
    assert.deepEqual(usage.vpns('pc'), [vpn]);
    assert.deepEqual(usage.snapshot(machine, 2).vpns, [{ name: 'Steeprock', status: 'connected', pending: null, error: null }]);
    take(usage, { ...report, vpns: [] }, 3);
    assert.deepEqual(usage.snapshot(machine, 3).vpns, []);
  } finally { close(); }
});
