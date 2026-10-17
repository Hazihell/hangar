import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlertEvaluator as createAlerts, DEFAULT_RULES, loadRules, tempLimits, RETRY_EVERY, RETRY_FOR } from './alerts.ts';
import type { Context, MachineView, Notification, Rules } from './alerts.ts';

const S = 1000, MIN = 60_000;
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);
const iso = (t: number) => new Date(t).toISOString();
const GB = 1024 ** 3;

function machine(t: number, patch: Partial<MachineView> & { cpu?: number; ramPct?: number; disks?: [string, number][]; t3?: boolean; temp?: number } = {}): MachineView {
  const { cpu = 10, ramPct = 40, disks = [['C:', 50]], t3, temp, ...rest } = patch;
  return {
    id: 'stormtrooper', name: 'Stormtrooper', online: true, lastSeen: iso(t),
    usage: {
      at: iso(t), cpu, ram: { used: ramPct * 100 * 1024 ** 2, total: 10_000 * 1024 ** 2 },
      disks: disks.map(([name, pct]) => ({ name, used: pct * GB, total: 100 * GB })),
      ...(t3 === undefined ? {} : { services: { t3 } }),
      ...(temp === undefined ? {} : { temps: { cpu: temp } }),
    },
    vpns: [], apps: null, ...rest,
  };
}
type Alerts = ReturnType<typeof createAlerts>;
/** `evaluate`, with every notification accepted by a subscription (unless `ack` is false). */
function watch(a: Alerts, ack = true) {
  return (machines: MachineView[], now: number, ctx?: Context) => {
    const out = a.evaluate(machines, now, ctx);
    if (ack) for (const n of out) a.delivered(n, true, now);
    return out;
  };
}
/** Reports every 10 s from `from` to `to` seconds, returning what was sent. */
function feed(a: Alerts, from: number, to: number, patch: (s: number) => Parameters<typeof machine>[1], ev = watch(a)) {
  const out: Notification[] = [];
  for (let s = from; s <= to; s += 10) out.push(...ev([machine(T0 + s * S, patch(s))], T0 + s * S));
  return out;
}
const rules = (patch: Partial<Rules> = {}): Rules => ({ ...structuredClone(DEFAULT_RULES), ...patch });
const NB = ' ';

test('a full disk fires once, stays quiet while full and between clear and at, then clears quietly with the same tag', () => {
  const a = createAlerts(rules()), ev = watch(a);
  assert.deepEqual(ev([machine(T0, { disks: [['C:', 80]] })], T0), []);
  const fired = ev([machine(T0 + 10 * S, { disks: [['C:', 91]] })], T0 + 10 * S);
  assert.equal(fired.length, 1);
  assert.deepEqual({ ...fired[0], body: '' }, { title: 'C: on Stormtrooper nearly full', body: '', tag: 'stormtrooper:disk:C:', machine: 'stormtrooper', quiet: false, gen: 1 });
  assert.equal(fired[0].body, `91${NB}% full, 9.0${NB}GB free of 100${NB}GB`);
  assert.deepEqual(ev([machine(T0 + 20 * S, { disks: [['C:', 99]] })], T0 + 20 * S), []);
  assert.deepEqual(ev([machine(T0 + 30 * S, { disks: [['C:', 87]] })], T0 + 30 * S), [], 'between clear and at: neither fires nor clears');
  const cleared = ev([machine(T0 + 40 * S, { disks: [['C:', 84]] })], T0 + 40 * S);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].title, `C: on Stormtrooper is below 85${NB}%`);
  assert.equal(cleared[0].tag, 'stormtrooper:disk:C:');
  assert.equal(cleared[0].quiet, true);
  assert.deepEqual(ev([machine(T0 + 50 * S, { disks: [['C:', 80]] })], T0 + 50 * S), []);
});

test('each disk has its own Alert; both full at the first evaluation fire once each', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const m = machine(T0, { disks: [['C:', 95], ['D:', 92], ['E:', 10]] });
  assert.deepEqual(ev([m], T0).map(n => n.tag), ['stormtrooper:disk:C:', 'stormtrooper:disk:D:']);
  assert.deepEqual(ev([m], T0 + 5 * S), []);
});

test('CPU needs every report for `for` seconds at or above `at`, and a dip below resets the count', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const cpu = (from: number, to: number, value: number) => feed(a, from, to, () => ({ cpu: value }), ev);
  assert.deepEqual(cpu(0, 250, 95), []);
  assert.deepEqual(cpu(260, 260, 85), [], 'below at (but above clear) resets the streak');
  assert.deepEqual(cpu(270, 560, 95), []);
  const fired = cpu(570, 570, 97);
  assert.equal(fired.length, 1);
  assert.deepEqual({ title: fired[0].title, body: fired[0].body, tag: fired[0].tag, quiet: fired[0].quiet }, { title: 'Stormtrooper CPU high', body: `97${NB}% for 5 min`, tag: 'stormtrooper:cpu', quiet: false });
  assert.deepEqual(cpu(580, 580, 99), []);
  assert.deepEqual(cpu(590, 590, 85), [], 'hysteresis: not below clear yet');
  const cleared = cpu(600, 600, 70);
  assert.deepEqual(cleared.map(n => [n.title, n.tag, n.quiet]), [['Stormtrooper CPU back to normal', 'stormtrooper:cpu', true]]);
});

test('a gap of more than a minute between samples (restart, sleep) restarts the CPU streak', () => {
  const a = createAlerts(rules()), ev = watch(a);
  feed(a, 0, 200, () => ({ cpu: 95 }), ev);
  // no reports from 210 to 280, then 95 % again: the 200 s already counted do not carry over
  assert.deepEqual(feed(a, 290, 580, () => ({ cpu: 95 }), ev), []);
  assert.equal(feed(a, 590, 590, () => ({ cpu: 95 }), ev).length, 1);
  // a 60 s gap still counts as one streak
  const b = createAlerts(rules()), evb = watch(b);
  evb([machine(T0, { cpu: 95 })], T0);
  evb([machine(T0 + 60 * S, { cpu: 95 })], T0 + 60 * S);
  assert.equal(feed(b, 70, 300, () => ({ cpu: 95 }), evb).length, 1);
});

test('the 5 s tick between reports does not shorten or lengthen the streak', () => {
  const a = createAlerts(rules()), ev = watch(a);
  for (let s = 0; s < 300; s += 5) {
    const report = Math.floor(s / 10) * 10; // reports every 10 s, ticks every 5 s on the latest one
    assert.deepEqual(ev([machine(T0 + report * S, { cpu: 95 })], T0 + s * S), []);
  }
  assert.equal(ev([machine(T0 + 300 * S, { cpu: 95 })], T0 + 300 * S).length, 1);
});

test('RAM high works on the used share of total', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const fired = feed(a, 0, 300, () => ({ ramPct: 95 }), ev);
  assert.deepEqual(fired.map(n => [n.title, n.tag]), [['Stormtrooper RAM high', 'stormtrooper:ram']]);
  const cleared = feed(a, 310, 310, () => ({ ramPct: 80 }), ev);
  assert.deepEqual(cleared.map(n => [n.title, n.quiet]), [['Stormtrooper RAM back to normal', true]]);
});

test('CPU and RAM bodies name up to three Top Apps, WSL ones prefixed, the WSL App itself skipped', () => {
  const apps = {
    list: [
      { name: 'WSL', cpu: 80, ram: 9 * GB, apps: [{ name: 'node', cpu: 61, ram: 2 * GB }, { name: 'claude', cpu: 18, ram: 600 * 1024 ** 2 }, { name: 'zsh', cpu: 0, ram: 5 * 1024 ** 2 }] },
      { name: 'chrome', cpu: 6, ram: 4.5 * GB },
      { name: 'Code', cpu: 3, ram: 1.2 * GB },
      { name: 'Slack', cpu: 0.4, ram: 900 * 1024 ** 2 },
    ],
  };
  const a = createAlerts(rules());
  const [cpu, ram] = feed(a, 0, 300, () => ({ cpu: 97, ramPct: 96, apps }));
  assert.equal(cpu.body, `97${NB}% for 5 min: WSL node 61${NB}%, WSL claude 18${NB}%, chrome 6${NB}%`);
  assert.equal(ram.body, `96${NB}% for 5 min: chrome 4.5${NB}GB, WSL node 2.0${NB}GB, Code 1.2${NB}GB`);
  // apps unknown: no list
  assert.equal(feed(createAlerts(rules()), 0, 300, () => ({ cpu: 97 }))[0].body, `97${NB}% for 5 min`);
});

test('CPU temperature fires after `for` seconds at or above `at`, with the Top Apps, and clears below `clear`', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const temp = (from: number, to: number, value: number, apps: MachineView['apps'] = null) => feed(a, from, to, () => ({ temp: value, apps }), ev);
  assert.deepEqual(temp(0, 250, 90), []);
  assert.deepEqual(temp(260, 260, 80), [], 'below at (but above clear) resets the streak');
  assert.deepEqual(temp(270, 560, 90), []);
  const fired = temp(570, 570, 87, { list: [{ name: 'chrome', cpu: 40, ram: GB }, { name: 'node', cpu: 12, ram: GB }] });
  assert.equal(fired.length, 1);
  assert.deepEqual({ title: fired[0].title, body: fired[0].body, tag: fired[0].tag, machine: fired[0].machine, quiet: fired[0].quiet }, { title: 'Stormtrooper CPU hot', body: `87${NB}°C for 5 min: chrome 40${NB}%, node 12${NB}%`, tag: 'stormtrooper:temp', machine: 'stormtrooper', quiet: false });
  assert.deepEqual(temp(580, 580, 95), []);
  assert.deepEqual(temp(590, 590, 80), [], 'hysteresis: not below clear yet');
  const cleared = temp(600, 600, 72);
  assert.deepEqual(cleared.map(n => [n.title, n.body, n.tag, n.quiet]), [['Stormtrooper CPU temperature back to normal', `Now 72${NB}°C`, 'stormtrooper:temp', true]]);
  assert.deepEqual(feed(createAlerts(rules()), 0, 300, () => ({ temp: 88 }))[0].body, `88${NB}°C for 5 min`);
});

test('a Machine with its own temperature limits uses them', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const air = (s: number, temp: number) => ev([machine(at(s), { id: 'rogers-macbook-air', name: 'MacBook Air', temp })], at(s));
  const out: Notification[] = [];
  for (let s = 0; s <= 300; s += 10) out.push(...air(s, 100));
  assert.deepEqual(out, [], '100 °C is normal for the fanless M4');
  for (let s = 310; s <= 610; s += 10) out.push(...air(s, 106));
  assert.deepEqual(out.map(n => [n.title, n.body, n.tag]), [['MacBook Air CPU hot', `106${NB}°C for 5 min`, 'rogers-macbook-air:temp']]);
  assert.deepEqual(air(620, 96), [], 'between its clear and at');
  assert.deepEqual(air(630, 94).map(n => [n.title, n.quiet]), [['MacBook Air CPU temperature back to normal', true]]);
  // the PC keeps the shared limits next to it
  assert.deepEqual(feed(createAlerts(rules()), 0, 300, () => ({ temp: 100 })).map(n => n.title), ['Stormtrooper CPU hot']);
});

test('a Machine that stops reporting its CPU temperature resets the streak, and releases an Alert that was firing', () => {
  const a = createAlerts(rules()), ev = watch(a);
  feed(a, 0, 200, () => ({ temp: 90 }), ev);
  assert.deepEqual(feed(a, 210, 220, () => ({}), ev), []);
  assert.deepEqual(feed(a, 230, 520, () => ({ temp: 90 }), ev), [], 'the 200 s before the gap do not count');
  assert.equal(feed(a, 530, 530, () => ({ temp: 90 }), ev).length, 1);
  const gone = feed(a, 540, 540, () => ({}), ev);
  assert.deepEqual(gone.map(n => [n.title, n.body, n.tag, n.quiet]), [['CPU temperature on Stormtrooper is no longer reported', '', 'stormtrooper:temp', true]]);
  assert.deepEqual(feed(a, 550, 560, () => ({}), ev), []);
  assert.deepEqual(a.active(), []);
  // a Machine that never reports one never has an entry
  const b = createAlerts(rules());
  b.evaluate([machine(T0)], T0);
  assert.deepEqual(Object.keys(b.state().entries), []);
});

test('going Offline resets the temperature streak, and the rule can be turned off', () => {
  const a = createAlerts(rules()), ev = watch(a);
  feed(a, 0, 200, () => ({ temp: 90 }), ev);
  ev([{ ...machine(at(210), { temp: 90 }), online: false }], at(210));
  assert.deepEqual(feed(a, 220, 500, () => ({ temp: 90 }), ev), []);
  assert.equal(feed(a, 510, 520, () => ({ temp: 90 }), ev).length, 1);
  for (const temp of [undefined, false] as const) {
    assert.deepEqual(feed(createAlerts(rules({ temp })), 0, 600, () => ({ temp: 120 })), []);
    assert.equal(tempLimits(rules({ temp }), 'stormtrooper'), null);
  }
  assert.deepEqual(tempLimits(rules(), 'stormtrooper'), { high: 75, hot: 85 });
  assert.deepEqual(tempLimits(rules(), 'rogers-macbook-air'), { high: 95, hot: 105 });
  assert.deepEqual(tempLimits(rules({ temp: { at: 80, clear: 70, for: 60, machines: { air: { at: 100 } } } }), 'air'), { high: 70, hot: 100 });
});

test('T3 stopped fires on true to false, not while false, and clears when true again', () => {
  const a = createAlerts(rules()), ev = watch(a);
  assert.deepEqual(ev([machine(T0, { t3: true })], T0), []);
  assert.deepEqual(ev([machine(T0 + 10 * S, { t3: false })], T0 + 10 * S).map(n => [n.title, n.tag, n.quiet]), [['T3 service stopped on Stormtrooper', 'stormtrooper:t3', false]]);
  assert.deepEqual(ev([machine(T0 + 20 * S, { t3: false })], T0 + 20 * S), []);
  assert.deepEqual(ev([machine(T0 + 30 * S, { t3: true })], T0 + 30 * S).map(n => [n.title, n.tag, n.quiet]), [['T3 service running again on Stormtrooper', 'stormtrooper:t3', true]]);
  // a Machine that does not report T3 never fires it
  assert.deepEqual(createAlerts(rules()).evaluate([machine(T0)], T0), []);
});

const mac = (t: number, vpns: MachineView['vpns']): MachineView => machine(t, { id: 'mac', name: 'MacBook Air', vpns });
const vpn = (status: string, pending: { action: string } | null = null) => [{ name: 'Steeprock', status, pending }];
const at = (s: number) => T0 + s * S;

test('VPN dropped fires on connected to disconnected, clears when connected again', () => {
  const a = createAlerts(rules()), ev = watch(a);
  assert.deepEqual(ev([mac(at(0), vpn('connected'))], at(0)), []);
  const fired = ev([mac(at(10), vpn('disconnected'))], at(10));
  assert.deepEqual(fired.map(n => [n.title, n.tag, n.machine, n.quiet]), [['Steeprock dropped on MacBook Air', 'mac:vpn:Steeprock', 'mac', false]]);
  assert.deepEqual(ev([mac(at(20), vpn('disconnected'))], at(20)), []);
  assert.deepEqual(ev([mac(at(30), vpn('connecting'))], at(30)), []);
  const cleared = ev([mac(at(40), vpn('connected'))], at(40));
  assert.deepEqual(cleared.map(n => [n.title, n.tag, n.quiet]), [['Steeprock reconnected on MacBook Air', 'mac:vpn:Steeprock', true]]);
});

test('connected, disconnecting, disconnected without a Dashboard command is a drop', () => {
  const a = createAlerts(rules()), ev = watch(a);
  ev([mac(at(0), vpn('connected'))], at(0));
  assert.deepEqual(ev([mac(at(10), vpn('disconnecting'))], at(10)), []);
  assert.equal(ev([mac(at(20), vpn('disconnected'))], at(20)).length, 1);
  // and through connecting
  const b = createAlerts(rules()), evb = watch(b);
  evb([mac(at(0), vpn('connected'))], at(0));
  evb([mac(at(10), vpn('connecting'))], at(10));
  assert.equal(evb([mac(at(20), vpn('disconnected'))], at(20)).length, 1);
});

test('a Dashboard disconnect is not a drop, with the real ordering: the report that shows it done also clears `pending`', () => {
  const a = createAlerts(rules()), ev = watch(a);
  ev([mac(at(0), vpn('connected'))], at(0));
  // the command starts
  assert.deepEqual(ev([mac(at(5), vpn('connected', { action: 'disconnect' }))], at(5)), []);
  // the report arrives: pending already cleared, the server says which disconnects just completed
  const ctx = { completedDisconnects: [{ machine: 'mac', vpn: 'Steeprock' }] };
  assert.deepEqual(ev([mac(at(10), vpn('disconnected'))], at(10), ctx), []);
  assert.deepEqual(ev([mac(at(15), vpn('disconnected'))], at(15)), []);
  // even if the pending snapshot was never evaluated, the context is enough
  const b = createAlerts(rules()), evb = watch(b);
  evb([mac(at(0), vpn('connected'))], at(0));
  assert.deepEqual(evb([mac(at(10), vpn('disconnected'))], at(10), ctx), []);
  // and even if only the pending snapshot was seen (disconnecting, then disconnected with nothing else)
  const c = createAlerts(rules()), evc = watch(c);
  evc([mac(at(0), vpn('connected'))], at(0));
  evc([mac(at(5), vpn('disconnecting', { action: 'disconnect' }))], at(5));
  assert.deepEqual(evc([mac(at(10), vpn('disconnected'))], at(10)), []);
  // a later real drop still fires
  evc([mac(at(20), vpn('connected'))], at(20));
  assert.equal(evc([mac(at(30), vpn('disconnected'))], at(30)).length, 1);
});

test('a VPN that is already disconnected at first sight or vanishes does not fire; a failed disconnect leaves it watchable', () => {
  assert.deepEqual(createAlerts(rules()).evaluate([mac(at(0), vpn('disconnected'))], at(0)), []);
  const b = createAlerts(rules()), evb = watch(b);
  evb([mac(at(0), vpn('connected'))], at(0));
  assert.deepEqual(evb([mac(at(5), [])], at(5)), []);
  assert.deepEqual(evb([mac(at(10), vpn('disconnected'))], at(10)), []);
  const c = createAlerts(rules()), evc = watch(c);
  evc([mac(at(0), vpn('connected'))], at(0));
  evc([mac(at(5), vpn('connected', { action: 'disconnect' }))], at(5));
  evc([mac(at(10), vpn('connected'))], at(10));
  assert.equal(evc([mac(at(15), vpn('disconnected'))], at(15)).length, 1);
});

test('Offline applies only to listed Machines, `for` seconds after the Machine went Offline (30 s after lastSeen), and clears when Online', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const off = (id: string, name: string): MachineView => ({ id, name, online: false, lastSeen: iso(T0), usage: null, vpns: [], apps: null });
  const both = [off('stormtrooper', 'Stormtrooper'), off('mac', 'MacBook Air')];
  assert.deepEqual(ev(both, T0 + 149 * S), []);
  const fired = ev(both, T0 + 150 * S);
  assert.deepEqual(fired.map(n => [n.title, n.body, n.tag, n.quiet]), [['Stormtrooper is Offline', 'Last seen 3 min ago', 'stormtrooper:offline', false]]);
  assert.deepEqual(ev(both, T0 + 155 * S), []);
  const back = ev([machine(T0 + 200 * S)], T0 + 200 * S);
  assert.deepEqual(back.map(n => [n.title, n.tag, n.quiet]), [['Stormtrooper is back Online', 'stormtrooper:offline', true]]);
  assert.deepEqual(ev([machine(T0 + 210 * S)], T0 + 210 * S), []);
});

test('a restarted Dashboard counts a Machine Offline only from when it started watching', () => {
  const a = createAlerts(rules());
  const stale: MachineView = { id: 'stormtrooper', name: 'Stormtrooper', online: false, lastSeen: iso(T0), usage: null, vpns: [], apps: null };
  const ctx = { observedFrom: T0 + 3600 * S };
  assert.deepEqual(a.evaluate([stale], T0 + 3601 * S, ctx), []);
  assert.deepEqual(a.evaluate([stale], T0 + 3719 * S, ctx), []);
  assert.equal(a.evaluate([stale], T0 + 3720 * S, ctx).length, 1);
});

test('an Offline Machine\'s stale CPU, RAM, disk, T3 and VPNs fire nothing and break the CPU streak', () => {
  const a = createAlerts(rules({ offline: { for: 120, machines: [] } })), ev = watch(a);
  feed(a, 0, 100, () => ({ cpu: 99 }), ev);
  const stale = { ...machine(T0 + 110 * S, { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false }), online: false };
  assert.deepEqual(ev([stale], T0 + 400 * S), []);
  // back Online at 99 %: the streak starts over
  assert.deepEqual(feed(a, 410, 700, () => ({ cpu: 99 }), ev), []);
  assert.equal(feed(a, 710, 710, () => ({ cpu: 99 }), ev).length, 1);
});

test('cooldown mutes a refire but the condition can still clear', () => {
  const a = createAlerts(rules({ cooldown: 1800 })), ev = watch(a);
  const disk = (s: number, pct: number) => ev([machine(T0 + s * S, { disks: [['C:', pct]] })], T0 + s * S);
  assert.equal(disk(0, 95).length, 1);
  assert.equal(disk(60, 70).length, 1, 'cleared');
  assert.deepEqual(disk(120, 95), [], 'inside the cooldown');
  assert.deepEqual(disk(180, 96), []);
  assert.deepEqual(disk(240, 70), [], 'nothing was sent for the muted occurrence, so nothing to replace');
  assert.equal(disk(1801, 95).length, 1, 'after the cooldown it fires again');
  assert.equal(disk(1900, 70)[0].quiet, true);
});

test('conditions already true at the first evaluation fire once', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const m = machine(T0, { disks: [['C:', 95]], t3: false });
  assert.deepEqual(ev([m], T0).map(n => n.tag).sort(), ['stormtrooper:disk:C:', 'stormtrooper:t3']);
  assert.deepEqual(ev([m], T0 + 5 * S), []);
});

test('a disk or VPN that stops being reported is retired with a quiet replacement, and can fire again later', () => {
  const a = createAlerts(rules({ cooldown: 100 })), ev = watch(a);
  const m = (s: number, disks: [string, number][]) => machine(T0 + s * S, { disks });
  assert.equal(ev([m(0, [['C:', 50], ['D:', 95]])], T0).length, 1);
  const gone = ev([m(10, [['C:', 50]])], at(10));
  assert.deepEqual(gone.map(n => [n.title, n.tag, n.quiet]), [[`D: on Stormtrooper is no longer reported`, 'stormtrooper:disk:D:', true]]);
  assert.deepEqual(ev([m(20, [['C:', 50]])], at(20)), []);
  // back and full after the cooldown: fires again instead of staying "active" forever
  assert.deepEqual(ev([m(30, [['C:', 50], ['D:', 95]])], at(30)), [], 'inside the cooldown');
  ev([m(40, [['C:', 50]])], at(40));
  assert.equal(ev([m(200, [['C:', 50], ['D:', 95]])], at(200)).length, 1);
  // a VPN that disappears while dropped
  const b = createAlerts(rules()), evb = watch(b);
  evb([mac(at(0), vpn('connected'))], at(0));
  assert.equal(evb([mac(at(10), vpn('disconnected'))], at(10)).length, 1);
  assert.deepEqual(evb([mac(at(20), [])], at(20)).map(n => [n.title, n.quiet]), [['Steeprock is no longer reported on MacBook Air', true]]);
  assert.deepEqual(b.state().vpns, {});
});

test('state does not grow: finished Alerts are forgotten once their cooldown is over', () => {
  const a = createAlerts(rules({ cooldown: 100 })), ev = watch(a);
  for (let i = 0; i < 50; i++) {
    const t = i * 300;
    ev([machine(at(t), { disks: [[`Disk${i}`, 95]] })], at(t));
    ev([machine(at(t + 10), { disks: [] })], at(t + 10)); // retired
    ev([machine(at(t + 20), { disks: [] })], at(t + 20));
  }
  ev([machine(at(15_000), { disks: [] })], at(15_000));
  assert.deepEqual(a.state(), { entries: {}, vpns: {} });
  // within the cooldown the last firing is remembered
  const b = createAlerts(rules({ cooldown: 1800 })), evb = watch(b);
  evb([machine(at(0), { disks: [['C:', 95]] })], at(0));
  evb([machine(at(10), { disks: [['C:', 10]] })], at(10));
  assert.deepEqual(Object.keys(b.state().entries), ['stormtrooper:disk:C:']);
  evb([machine(at(1800), { disks: [['C:', 10]] })], at(1800));
  assert.deepEqual(b.state().entries, {});
});

test('a notification no subscription accepted is retried every minute for ten minutes, then dropped', () => {
  const a = createAlerts(rules());
  const m = (s: number) => machine(at(s), { disks: [['C:', 95]] });
  assert.equal(a.evaluate([m(0)], at(0)).length, 1);
  assert.deepEqual(a.evaluate([m(30)], at(30)), []);
  const retry = a.evaluate([m(60)], at(60));
  assert.deepEqual(retry.map(n => [n.tag, n.quiet]), [['stormtrooper:disk:C:', false]]);
  assert.deepEqual(a.evaluate([m(100)], at(100)), []);
  assert.equal(a.evaluate([m(120)], at(120)).length, 1);
  a.delivered(retry[0], true, at(121));
  assert.deepEqual(a.evaluate([m(300)], at(300)), [], 'accepted: no more retries');
  // never accepted: stops after RETRY_FOR
  const b = createAlerts(rules());
  let sent = 0;
  for (let s = 0; s <= 1200; s += 10) sent += b.evaluate([m(s)], at(s)).length;
  assert.equal(sent, 1 + RETRY_FOR / RETRY_EVERY);
});

test('a clear is sent only for an Alert a device accepted', () => {
  const m = (s: number, pct: number) => machine(at(s), { disks: [['C:', pct]] });
  const a = createAlerts(rules());
  a.evaluate([m(0, 95)], at(0)); // never accepted
  assert.deepEqual(a.evaluate([m(10, 10)], at(10)), [], 'nobody saw it, nothing to replace');
  // an unaccepted clear is retried
  const c = createAlerts(rules());
  const [f] = c.evaluate([m(0, 95)], at(0));
  c.delivered(f, true, at(0));
  const [clear] = c.evaluate([m(10, 10)], at(10));
  assert.equal(clear.quiet, true);
  assert.equal(c.evaluate([m(70, 10)], at(70)).length, 1);
  c.delivered(clear, true, at(71));
  assert.deepEqual(c.evaluate([m(140, 10)], at(140)), []);
});

test('acknowledgements only count for their own generation', () => {
  const m = (s: number, pct: number) => machine(at(s), { disks: [['C:', pct]] });
  const a = createAlerts(rules({ cooldown: 0 }));
  const [fire1] = a.evaluate([m(0, 95)], at(0));
  a.delivered(fire1, true, at(1));
  const [clear2] = a.evaluate([m(10, 10)], at(10));
  const [fire3] = a.evaluate([m(20, 95)], at(20));
  const [clear4] = a.evaluate([m(30, 10)], at(30));
  assert.deepEqual([fire1.gen, clear2.gen, fire3.gen, clear4.gen], [1, 2, 3, 4]);
  // the older clear lands late: it must not wipe the newer clear's outbox
  a.delivered(clear2, true, at(31));
  a.delivered(fire3, true, at(31));
  assert.deepEqual(a.evaluate([m(90, 10)], at(90)).map(n => [n.gen, n.quiet]), [[4, true]], 'clear 4 is still being retried');
  a.delivered(clear4, true, at(91));
  assert.deepEqual(a.evaluate([m(160, 10)], at(160)), []);
});

test('current() answers a late acknowledgement of an out-of-date notification with the newest one', () => {
  const m = (s: number, pct: number) => machine(at(s), { disks: [['C:', pct]] });
  const a = createAlerts(rules({ cooldown: 0 }));
  const [fire1] = a.evaluate([m(0, 95)], at(0));
  assert.equal(a.current(fire1), null, 'still the newest');
  a.delivered(fire1, true, at(1));
  const [clear2] = a.evaluate([m(10, 10)], at(10));
  const next = a.current(fire1)!;
  assert.deepEqual([next.quiet, next.gen, next.title, next.tag], [true, 2, `C: on Stormtrooper is below 85${NB}%`, 'stormtrooper:disk:C:']);
  assert.equal(a.current(clear2), null);
  // a later fire is the newest: that is what the old one is answered with
  const [fire3] = a.evaluate([m(20, 95)], at(20));
  assert.deepEqual([a.current(clear2)!.quiet, a.current(clear2)!.gen], [false, 3]);
  assert.equal(a.current(fire3), null);
  // an Alert nobody accepted that cleared while its push was in flight: the late push is answered with the clear
  const b = createAlerts(rules());
  const [f] = b.evaluate([m(0, 95)], at(0));
  assert.deepEqual(b.evaluate([m(10, 10)], at(10)), []);
  b.delivered(f, true, at(11)); // stale: changes nothing
  assert.deepEqual(b.current(f)!.quiet, true);
  assert.deepEqual(b.active(), []);
  assert.equal(b.current({ ...f, tag: 'unknown' }), null);
});

test('active() lists the Alerts a new device should learn about', () => {
  const a = createAlerts(rules({ cooldown: 1800 })), ev = watch(a);
  ev([machine(at(0), { disks: [['C:', 95], ['D:', 96]], t3: false })], at(0));
  assert.deepEqual(a.active().map(n => [n.tag, n.quiet]).sort(), [['stormtrooper:disk:C:', false], ['stormtrooper:disk:D:', false], ['stormtrooper:t3', false]]);
  assert.match(a.active().find(n => n.tag === 'stormtrooper:disk:D:')!.title, /D: on Stormtrooper nearly full/);
  ev([machine(at(10), { disks: [['C:', 10], ['D:', 96]], t3: true })], at(10));
  assert.deepEqual(a.active().map(n => n.tag), ['stormtrooper:disk:D:']);
  // a muted refire is not something to tell a new device
  ev([machine(at(20), { disks: [['C:', 10], ['D:', 10]] })], at(20));
  ev([machine(at(30), { disks: [['C:', 95], ['D:', 10]] })], at(30));
  assert.deepEqual(a.active(), []);
});

test('state survives a JSON round trip: no repeat, no forgetting, streaks and cooldowns continue', () => {
  const a = createAlerts(rules()), ev = watch(a);
  const patch = { cpu: 95, disks: [['C:', 95]] as [string, number][], t3: false };
  feed(a, 0, 100, () => patch, ev);
  const b = createAlerts(rules(), JSON.parse(JSON.stringify(a.state()))), evb = watch(b);
  // disk and T3 do not repeat, and the CPU streak that began before the restart completes
  assert.deepEqual(feed(b, 110, 300, () => patch, evb).map(n => n.tag), ['stormtrooper:cpu']);
  // and everything still clears afterwards
  const c = createAlerts(rules(), JSON.parse(JSON.stringify(b.state()))), evc = watch(c);
  assert.deepEqual(evc([machine(at(310), { cpu: 10, disks: [['C:', 10]], t3: true })], at(310)).map(n => [n.tag, n.quiet]).sort(), [['stormtrooper:cpu', true], ['stormtrooper:disk:C:', true], ['stormtrooper:t3', true]]);
  // the cooldown is remembered
  assert.deepEqual(evc([machine(at(320), { disks: [['C:', 95]] })], at(320)), []);
  // garbage state is ignored
  assert.deepEqual(createAlerts(rules(), 'nope').state(), { entries: {}, vpns: {} });
  assert.deepEqual(createAlerts(rules(), { entries: { x: 5, y: { active: 'yes', outbox: { kind: 'fire' } } }, vpns: { z: 'maybe' } }).state().entries.y.outbox, null);
  // the VPN's last status is part of the state
  const v = createAlerts(rules()), evv = watch(v);
  evv([mac(at(0), vpn('connected'))], at(0));
  const w = createAlerts(rules(), JSON.parse(JSON.stringify(v.state())));
  assert.equal(w.evaluate([mac(at(5), vpn('disconnected'))], at(5)).length, 1);
  // so are unacknowledged notifications
  const p = createAlerts(rules());
  p.evaluate([machine(at(0), { disks: [['C:', 95]] })], at(0));
  const q = createAlerts(rules(), JSON.parse(JSON.stringify(p.state())));
  assert.equal(q.evaluate([machine(at(60), { disks: [['C:', 95]] })], at(60)).length, 1);
});

test('state() is a snapshot: later evaluations do not change it', () => {
  const a = createAlerts(rules());
  const before = a.state();
  a.evaluate([machine(T0, { disks: [['C:', 95]] })], T0);
  assert.deepEqual(before, { entries: {}, vpns: {} });
});

test('disabled rules stay silent', () => {
  const a = createAlerts(rules({ vpn: false, t3: false })), ev = watch(a);
  ev([machine(T0, { t3: true, vpns: vpn('connected') })], T0);
  assert.deepEqual(ev([machine(T0 + 5 * S, { t3: false, vpns: vpn('disconnected') })], T0 + 5 * S), []);
});

test('loadRules reads alerts.json, and falls back to the defaults with a warning on trouble', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-alerts-'));
  try {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    assert.deepEqual(loadRules(new URL('../alerts.json', import.meta.url).pathname, warn), DEFAULT_RULES);
    assert.deepEqual(warnings, []);
    const write = (value: unknown) => { const p = join(dir, 'a.json'); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
    const bad: unknown[] = [
      '{ nope',
      { ...DEFAULT_RULES, disk: { at: 85, clear: 90 } },
      { ...DEFAULT_RULES, disk: { at: 90, clear: 90 } },
      { ...DEFAULT_RULES, cpu: { at: 90, clear: 80, for: -1 } },
      { ...DEFAULT_RULES, cpu: { at: 120, clear: 80, for: 300 } },
      { ...DEFAULT_RULES, ram: { at: 90, clear: 'x', for: 300 } },
      { ...DEFAULT_RULES, temp: { at: 75, clear: 85, for: 300 } },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 85, for: 300 } },
      { ...DEFAULT_RULES, temp: { at: 151, clear: 75, for: 300 } },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 75 } },
      { ...DEFAULT_RULES, temp: true },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 75, for: 300, machines: [] } },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 75, for: 300, machines: { air: { at: 70, clear: 75 } } } },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 75, for: 300, machines: { air: { at: 'hot' } } } },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 75, for: 300, machines: { air: { limit: 90 } } } },
      { ...DEFAULT_RULES, temp: { at: 85, clear: 75, for: 300, machines: { air: 105 } } },
      { ...DEFAULT_RULES, offline: { for: 120, machines: 'stormtrooper' } },
      { ...DEFAULT_RULES, cooldown: -5 },
      { ...DEFAULT_RULES, vpn: 'yes' },
      { ...DEFAULT_RULES, t3: undefined },
    ];
    for (const value of bad) {
      warnings.length = 0;
      assert.deepEqual(loadRules(write(value), warn), DEFAULT_RULES, JSON.stringify(value));
      assert.equal(warnings.length, 1);
    }
    warnings.length = 0;
    assert.deepEqual(loadRules(join(dir, 'missing.json'), warn), DEFAULT_RULES);
    assert.equal(warnings.length, 1);
    const custom = { ...DEFAULT_RULES, cooldown: 60, offline: { for: 30, machines: [] } };
    assert.deepEqual(loadRules(write(custom), warn), custom);
    const { temp, ...older } = DEFAULT_RULES;
    for (const accepted of [older, { ...older, temp: false }, { ...older, temp: { at: 150, clear: 0, for: 0 } }, { ...older, temp: { at: 90, clear: 80, for: 60, machines: { air: { clear: 70 }, pc: {} } } }]) {
      warnings.length = 0;
      assert.deepEqual(loadRules(write(accepted), warn), accepted, JSON.stringify(accepted));
      assert.deepEqual(warnings, []);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('start/resume recovery suppresses Offline, T3 and VPN for three minutes on every Machine', () => {
  const a = createAlerts(rules()), ev = watch(a);
  ev([mac(at(0), vpn('connected'))], at(0));
  // Simulate startup with stored connected VPN state, and then the same recovery on resume.
  const b = createAlerts(rules(), a.state()), run = watch(b);
  for (const recovered of [10, 1000]) {
    b.recover(at(recovered));
    const offline: MachineView = { id: 'stormtrooper', name: 'Stormtrooper', online: false, lastSeen: iso(at(0)), usage: null };
    const views = (s: number) => [offline, { ...mac(at(s), vpn('disconnected')), usage: machine(at(s), { t3: false }).usage }];
    for (let s = recovered; s < recovered + 180; s += 5) assert.deepEqual(run(views(s), at(s)), []);
    const out = run(views(recovered + 180), at(recovered + 180));
    if (recovered === 10) assert.deepEqual(out.map(n => n.tag).sort(), ['mac:t3', 'stormtrooper:offline']);
    else assert.deepEqual(out, [], 'already-active problems stay active through another recovery');
    assert.equal(out.some(n => n.tag.includes(':vpn:')), false, 'a VPN left down by reboot never becomes a delayed drop');
  }
  run([mac(at(1200), vpn('connected'))], at(1200));
  assert.equal(run([mac(at(1210), vpn('disconnected'))], at(1210)).filter(n => n.tag.includes(':vpn:') && !n.quiet).length, 1);
});

test('recovery restarts CPU/RAM streaks even with short gaps and old sample timestamps, preserving active Alerts', () => {
  const a = createAlerts(rules({ cpu: { at: 90, clear: 80, for: 30 }, ram: { at: 90, clear: 80, for: 30 } })), ev = watch(a);
  ev([machine(at(0), { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false })], at(0));
  ev([machine(at(20), { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false })], at(20));
  a.recover(at(25));
  assert.deepEqual(ev([machine(at(20), { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false })], at(30)), []);
  assert.deepEqual(ev([machine(at(50), { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false })], at(50)), []);
  assert.deepEqual(ev([machine(at(55), { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false })], at(55)).map(n => n.tag).sort(), ['stormtrooper:cpu', 'stormtrooper:ram']);
  a.recover(at(60));
  assert.deepEqual(ev([machine(at(65), { cpu: 99, ramPct: 99, disks: [['C:', 99]], t3: false })], at(65)), [], 'active alerts are not cleared or refired by resetting timers');
  assert.deepEqual(a.active().map(n => n.tag).sort(), ['stormtrooper:cpu', 'stormtrooper:disk:C:', 'stormtrooper:ram', 'stormtrooper:t3']);
});
