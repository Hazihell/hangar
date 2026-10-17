import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlertEvaluator, createAlerts, DEFAULT_RULES, usageLimits } from './alerts.ts';
import type { MachineView, Rules } from './alerts.ts';

const S = 1000, MIN = 60_000;
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);
const GB = 1024 ** 3;
const NB = '\u202f';
const rules = (patch: Partial<Rules> = {}): Rules => ({ ...structuredClone(DEFAULT_RULES), ...patch });

function machine(id: string, t: number, { cpu = 10, disk = 50 }: { cpu?: number; disk?: number } = {}): MachineView {
  return {
    id, name: id.toUpperCase(), online: true, lastSeen: new Date(t).toISOString(),
    usage: { at: new Date(t).toISOString(), cpu, ram: { used: 1, total: 100 }, disks: [{ name: 'C:', used: disk * GB, total: 100 * GB }] },
    vpns: [], apps: null,
  };
}

/** Alerts as the server builds them, with the push service recorded. `vapid` may name an unusable key file. */
function fixture(t: any, patch: Partial<Rules> = {}, { dir = mkdtempSync(join(tmpdir(), 'hangar-attention-')), vapid }: { dir?: string; vapid?: string } = {}) {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});
  const pushes: string[] = [];
  const fetch = async (url: string) => { pushes.push(url); return { status: 201, ok: true }; };
  const open = (startedAt: number) => {
    const db = new DatabaseSync(join(dir, 'test.db'));
    const alerts = createAlerts({ db, dbPath: join(dir, 'test.db'), rules: rules(patch), vapid, fetch, clock: () => startedAt, startedAt });
    return { alerts, close: () => { alerts.close(); db.close(); } };
  };
  return { dir, pushes, open };
}
const titles = (list: { title: string }[]) => list.map(a => a.title);

test('attention lists an Alert exactly while the evaluator holds it active: after its duration, through hysteresis, until it clears', t => {
  const { open } = fixture(t);
  const { alerts, close } = open(T0);
  t.after(close);
  const at = (s: number, cpu: number) => alerts.observe([machine('pc', T0 + s * S, { cpu })], T0 + s * S);

  for (let s = 0; s <= 290; s += 10) at(s, 95);
  assert.deepEqual(alerts.attention('pc'), [], 'high for 290 s of the 300 s is not yet an Alert');
  at(300, 95);
  assert.deepEqual(alerts.attention('pc'), [{ tag: 'pc:cpu', title: 'PC CPU high', body: `95${NB}% for 5 min` }]);
  at(310, 85);
  assert.equal(alerts.attention('pc').length, 1, 'between clear (80) and at (90) it stays');
  at(320, 79);
  assert.deepEqual(alerts.attention('pc'), []);
});

test('attention keeps a cooldown-muted occurrence, with the text of the occurrence now, and sends nothing for it', async t => {
  const { open, pushes } = fixture(t, { cooldown: 1800 });
  const { alerts, close } = open(T0);
  t.after(close);
  assert.equal(alerts.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }, T0), true);
  await alerts.idle();

  alerts.observe([machine('pc', T0, { disk: 95 })], T0);
  await alerts.idle();
  assert.equal(pushes.length, 1);
  assert.deepEqual(titles(alerts.attention('pc')), ['C: on PC nearly full']);

  alerts.observe([machine('pc', T0 + 10 * S, { disk: 70 })], T0 + 10 * S); // cleared
  assert.deepEqual(alerts.attention('pc'), []);
  alerts.observe([machine('pc', T0 + 20 * S, { disk: 99 })], T0 + 20 * S); // inside the cooldown: muted
  await alerts.idle();
  assert.equal(pushes.length, 2, 'only the clear was pushed; the muted fire was not');
  assert.deepEqual(alerts.attention('pc'), [{ tag: 'pc:disk:C:', title: 'C: on PC nearly full', body: `99${NB}% full, 1.0${NB}GB free of 100${NB}GB` }]);
});

test('attention works, and persists, when the VAPID key is unusable: delivery is off, the evaluator is not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-attention-'));
  const vapid = join(dir, 'broken.json');
  writeFileSync(vapid, 'not json');
  const { open, pushes } = fixture(t, {}, { dir, vapid });
  const first = open(T0);
  assert.equal(first.alerts.publicKey, null);
  assert.equal(first.alerts.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a', auth: 'b' } }, T0), false);

  first.alerts.observe([machine('pc', T0, { disk: 95 })], T0);
  await first.alerts.idle();
  assert.deepEqual(titles(first.alerts.attention('pc')), ['C: on PC nearly full']);
  first.close();

  // the Dashboard restarts: the Alert is still active, and a recovered disk still clears it
  const second = open(T0 + MIN);
  t.after(second.close);
  assert.deepEqual(titles(second.alerts.attention('pc')), ['C: on PC nearly full']);
  second.alerts.observe([machine('pc', T0 + MIN, { disk: 50 })], T0 + MIN);
  assert.deepEqual(second.alerts.attention('pc'), []);
  assert.deepEqual(pushes, []);
});

test('attention is per Machine, and a Machine that stops reporting a disk drops that Alert', t => {
  const { open } = fixture(t);
  const { alerts, close } = open(T0);
  t.after(close);
  alerts.observe([machine('pc', T0, { disk: 95 }), machine('mac', T0, { disk: 10 })], T0);
  assert.deepEqual(titles(alerts.attention('pc')), ['C: on PC nearly full']);
  assert.deepEqual(alerts.attention('mac'), []);
  assert.deepEqual(alerts.attention('nobody'), []);

  const gone = machine('pc', T0 + 10 * S);
  gone.usage!.disks = [];
  alerts.observe([gone, machine('mac', T0 + 10 * S)], T0 + 10 * S);
  assert.deepEqual(alerts.attention('pc'), []);
});

test('an Alert saved before attention existed still lists, with its newest notification', () => {
  const evaluator = createAlertEvaluator(rules(), { entries: {
    'pc:t3': { active: true, delivered: true, gen: 1, latest: { kind: 'fire', title: 'T3 service stopped on PC', body: 'It is not running any more', machine: 'pc', gen: 1, at: T0 }, lastFired: T0 },
  } });
  assert.deepEqual(evaluator.attention('pc'), [{ tag: 'pc:t3', title: 'T3 service stopped on PC', body: 'It is not running any more' }]);
});

test('usageLimits: the page calls the rule\'s `clear` high and its `at` hot', () => {
  assert.deepEqual(usageLimits(DEFAULT_RULES), { cpu: { high: 80, hot: 90 }, ram: { high: 85, hot: 90 }, disk: { high: 85, hot: 90 } });
  const own = rules({ cpu: { at: 95, clear: 10, for: 60 }, ram: { at: 70, clear: 60, for: 60 }, disk: { at: 85, clear: 84 } });
  assert.deepEqual(usageLimits(own), { cpu: { high: 10, hot: 95 }, ram: { high: 60, hot: 70 }, disk: { high: 84, hot: 85 } });
});
