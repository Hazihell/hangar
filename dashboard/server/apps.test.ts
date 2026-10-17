import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApps, mayQuit } from './apps.ts';
import { validReport, validQuit } from './rules.ts';
import { Store } from './store.ts';
const pc = { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' };
const mac = { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac' };
const p = { pid: 10, name: 'chrome.exe', app: 'Chrome', cpu: 5, ram: 100, started: 'token', own: true };
const report = { machine: 'pc', cpu: 10, ram: { used: 1, total: 2 }, disks: [] };
test('Process validation bounds lists, identity, usage and optional reporter PID', () => {
  assert.ok(validReport({ ...report, processes: [p], wsl: [p], reporterPid: 1 }));
  for (const patch of [{ pid: 0 }, { pid: 1.5 }, { name: '' }, { name: 'x\u0085' }, { app: 'x'.repeat(257) }, { cpu: 101 }, { cpu: NaN }, { ram: -1 }, { started: 'x'.repeat(65) }, { own: 1 }]) {
    for (const key of ['processes', 'wsl']) {
      const input = { ...report, [key]: [{ ...p, ...patch }] };
      assert.equal(validReport(input), true);
      assert.deepEqual(input[key], []);
      const mixed = { ...report, [key]: [p, { ...p, ...patch }] };
      assert.equal(validReport(mixed), true);
      assert.deepEqual(mixed[key], [p]);
    }
  }
  assert.ok(validReport({ ...report, processes: Array(2000).fill(p) }));
  assert.equal(validReport({ ...report, processes: Array(2001).fill(p) }), false);
  assert.equal(validReport({ ...report, reporterPid: -1 }), false);
  assert.ok(validQuit({ targets: [{ pid: 1, started: '‘; quote' }], force: false }));
  for (const value of [{ targets: [], force: false }, { targets: Array(201).fill({ pid: 1, started: '' }), force: false }, { targets: [{ pid: 1, started: '', where: 'mac' }], force: true }, { targets: [{ pid: 1, started: '' }] }]) assert.equal(validQuit(value), false);
});
test('Apps sum all Processes, cap expanded Processes at twenty and select CPU/RAM union', () => {
  const processes = Array.from({ length: 25 }, (_, i) => ({ ...p, pid: i + 1, cpu: 1 }));
  const app = buildApps({ processes }, pc, 'now')!.list[0];
  assert.equal(app.cpu, 25); assert.equal(app.ram, 2500); assert.equal(app.count, 25); assert.equal(app.processes.length, 20); assert.equal(app.quit, true);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...p, pid: i + 1, app: String(i), cpu: i, ram: 30 - i }));
  const names = buildApps({ processes: many }, pc, 'now')!.list.map(a => a.name);
  assert.equal(names.length, 20); assert.ok(names.includes('29')); assert.ok(names.includes('0')); assert.equal(names.includes('15'), false);
});
test('WSL nests its Apps and excludes vmmemWSL from Windows Apps', () => {
  const apps = buildApps({ processes: [{ ...p, name: 'vmmemWSL', app: 'vmmemWSL', cpu: 20, ram: 500 }], wsl: [{ ...p, name: 'node', app: 'node' }] }, pc, 'now')!;
  assert.equal(apps.list.length, 1); assert.equal(apps.list[0].name, 'WSL'); assert.equal(apps.list[0].cpu, 20); assert.equal(apps.list[0].quit, false); assert.equal(apps.list[0].apps![0].name, 'node');
});
test('protection covers access, desktop, reporter, server ancestry and t3 MainPID', () => {
  for (const name of 'vmmemWSL vmmem wsl wslhost wslservice wslrelay svchost StartMenuExperienceHost ShellExperienceHost TextInputHost SearchHost explorer dwm csrss winlogon ctfmon sihost fontdrvhost RuntimeBroker tailscale-ipn tailscaled'.split(' ')) assert.equal(mayQuit({ ...p, name: name.toUpperCase() + '.EXE' }, pc, undefined), false, name);
  assert.equal(mayQuit(p, pc, undefined, { windows: new Set([10]) }), false);
  for (const name of 'WindowServer loginwindow Dock Finder SystemUIServer launchd sshd sshd-session sshd-session: tailscaled mac-reporter.sh'.split(' ')) assert.equal(mayQuit({ ...p, name }, mac, undefined), false, name);
  assert.equal(mayQuit({ ...p, app: 'Tailscale' }, mac, undefined), false);
  assert.equal(mayQuit(p, mac, undefined, {}, 10), false);
  assert.equal(mayQuit({ ...p, own: false }, pc, undefined), false);
  assert.equal(mayQuit({ ...p, started: '' }, pc, undefined), false);
  for (const patch of [{ pid: 1 }, { name: 'systemd' }, { name: 'init' }, { name: 'sshd' }, { name: 'tailscaled' }]) assert.equal(mayQuit({ ...p, ...patch }, pc, 'wsl'), false);
  assert.equal(mayQuit(p, pc, 'wsl', { wsl: new Set([10]) }), false);
  assert.equal(mayQuit(p, pc, 'wsl', { t3: 10 }), false);
  assert.equal(mayQuit({ ...p, pid: 11 }, pc, 'wsl', { t3: 10 }), true);
});
test('minute Top Apps average missing Apps as zero, rank WSL together and prune with History', () => {
  const store = new Store(':memory:', [pc]);
  try {
    store.intake({ ...report, processes: [p, { ...p, pid: 11, app: 'vmmemWSL', name: 'vmmemWSL' }], wsl: [{ ...p, app: 'node', cpu: 20 }] }, 1);
    store.intake({ ...report, processes: [], wsl: [] }, 2);
    assert.deepEqual(store.topApps('pc', '1970-01-01T00:00:00.000Z', 2), { t: '1970-01-01T00:00:00.000Z', apps: [{ name: 'node', where: 'wsl', cpu: 10, ram: 50 }, { name: 'Chrome', cpu: 2.5, ram: 50 }] });
    assert.equal(store.topApps('pc', 'bad', 2), null);
    assert.equal(store.topApps('pc', '1970-01-01T00:01:00.000Z', 2), null);
    store.prune(86400001); assert.equal(store.topApps('pc', '1970-01-01T00:00:00.000Z', 86400001), null);
  } finally { store.close(); }
});
test('minute Top Apps persist across restart while live Apps remain in memory', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hangar-apps-')); t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'history.db');
  let store = new Store(file, [pc]);
  store.intake({ ...report, processes: [p] }, 1); store.close();
  store = new Store(file, [pc]);
  try {
    assert.equal(store.snapshot(pc, 2).apps, null);
    assert.deepEqual(store.topApps('pc', '1970-01-01T00:00:00.000Z', 2)!.apps, [{ name: 'Chrome', cpu: 5, ram: 100 }]);
  } finally { store.close(); }
});
