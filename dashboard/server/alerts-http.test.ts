import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from './server.ts';
import { DEFAULT_RULES } from './alerts.ts';
import { generateVapid } from './push.ts';

const machines = [
  { id: 'pc', name: 'PC', os: 'windows', collector: 'wsl' },
  { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' },
];
const rules = { ...DEFAULT_RULES, offline: { for: 120, machines: [] } };
const GB = 1024 ** 3;

/** A browser's push endpoint: it holds the private key, so it can decrypt what the server sends. */
function device(name: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = Buffer.alloc(16, name.length);
  const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
    const secret = ecdh.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    assert.equal(plain[plain.length - 1], 2);
    return JSON.parse(plain.subarray(0, plain.length - 1).toString());
  };
  return { subscription, decrypt };
}

type Call = { url: string; headers: Record<string, string>; body: Buffer };

type Options = { dir?: string; now?: number; status?: (url: string, call: number) => number; gate?: (url: string, nth: number) => Promise<void> | undefined; rules?: typeof rules };
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(condition(), 'timed out'); };

async function fixture(t: any, { dir = mkdtempSync(join(tmpdir(), 'hangar-alerts-')), now: start = 120_000, status = () => 201, gate, rules: own = rules }: Options = {}) {
  let now = start;
  const calls: Call[] = [];
  const fetch = async (url: string, init: any) => {
    const nth = calls.filter(c => c.url === url).length, call = calls.length;
    calls.push({ url, headers: init.headers, body: init.body });
    await gate?.(url, nth);
    return { status: status(url, call), ok: status(url, call) < 300 };
  };
  const app = createDashboard({ db: join(dir, 'test.db'), machines, collect: false, clock: () => now, dist: join(dir, 'missing'), rules: own, fetch, exec: (_f, _a, _o, done) => { void done; } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.listening ? app.close() : undefined);
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const json = (method: string, path: string, value: unknown, type = 'application/json') => globalThis.fetch(base + path, { method, headers: { 'Content-Type': type }, body: JSON.stringify(value) });
  const report = (patch: any = {}) => json('POST', '/api/report', { machine: 'pc', cpu: 10, ram: { used: 1, total: 4 }, disks: [{ name: 'C:', used: 50 * GB, total: 100 * GB }], ...patch });
  const full = (pct: number) => ({ disks: [{ name: 'C:', used: pct * GB, total: 100 * GB }] });
  return { app, dir, base, calls, json, report, full, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; } };
}

test('subscribe, cross a threshold, get an encrypted push; clear it; 410 deletes the subscription', async t => {
  const f = await fixture(t);
  t.after(() => rmSync(f.dir, { recursive: true }));
  const pub = (await (await fetch(f.base + '/api/alerts/key')).json()).publicKey;
  assert.equal(pub, JSON.parse(readFileSync(join(f.dir, 'vapid.json'), 'utf8')).publicKey);

  const phone = device('phone');
  assert.equal((await f.json('POST', '/api/alerts/subscriptions', phone.subscription, 'text/plain')).status, 400, 'JSON content type required');
  assert.equal((await f.json('POST', '/api/alerts/subscriptions', { ...phone.subscription, endpoint: 'http://fcm.googleapis.com/x' })).status, 400);
  assert.equal((await f.json('POST', '/api/alerts/subscriptions', { endpoint: 'https://fcm.googleapis.com/x' })).status, 400);
  assert.equal((await f.json('POST', '/api/alerts/subscriptions', phone.subscription)).status, 201);
  assert.equal((await f.json('POST', '/api/alerts/subscriptions', phone.subscription)).status, 201, 'again replaces');

  assert.equal((await f.report(f.full(60))).status, 204);
  await f.app.idle();
  assert.equal(f.calls.length, 0, 'below the threshold');

  f.advance(10_000);
  assert.equal((await f.report(f.full(95))).status, 204);
  await f.app.idle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, phone.subscription.endpoint);
  assert.equal(f.calls[0].headers['Content-Encoding'], 'aes128gcm');
  assert.equal(f.calls[0].headers.Urgency, 'high');
  assert.match(f.calls[0].headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(phone.decrypt(f.calls[0].body), { title: 'C: on PC nearly full', body: '95 % full, 5.0 GB free of 100 GB', tag: 'pc:disk:C:', machine: 'pc', quiet: false });

  f.advance(10_000);
  await f.report(f.full(95));
  await f.app.idle();
  assert.equal(f.calls.length, 1, 'not again while it holds');

  f.advance(10_000);
  await f.report(f.full(50));
  await f.app.idle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].headers.Urgency, 'normal');
  assert.deepEqual(phone.decrypt(f.calls[1].body), { title: `C: on PC is below 85 %`, body: 'Now 50 %', tag: 'pc:disk:C:', machine: 'pc', quiet: true });

  // the push service says the device is gone
  const gone = device('gone');
  const g = await fixture(t, { status: () => 410 });
  t.after(() => rmSync(g.dir, { recursive: true }));
  await g.json('POST', '/api/alerts/subscriptions', gone.subscription);
  await g.report(g.full(95));
  await g.app.idle();
  assert.equal(g.calls.length, 1);
  assert.equal((await g.json('POST', '/api/alerts/test', { endpoint: gone.subscription.endpoint })).status, 404, 'deleted');
});

test('a failing or throwing push service never breaks report handling', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-alerts-')); t.after(() => rmSync(dir, { recursive: true }));
  t.mock.method(console, 'error', () => {});
  const app = createDashboard({ db: join(dir, 'test.db'), machines, collect: false, clock: () => 120_000, dist: join(dir, 'missing'), rules, fetch: async () => { throw new Error('network down'); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const phone = device('phone');
  const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  await post('/api/alerts/subscriptions', phone.subscription);
  const res = await post('/api/report', { machine: 'pc', cpu: 10, ram: { used: 1, total: 4 }, disks: [{ name: 'C:', used: 95 * GB, total: 100 * GB }] });
  assert.equal(res.status, 204);
  await app.idle();
  const test = await post('/api/alerts/test', { endpoint: phone.subscription.endpoint });
  assert.equal(test.status, 502);
  assert.equal((await test.json()).status, 0);
});

test('POST /api/alerts/test and DELETE /api/alerts/subscriptions', async t => {
  let code = 201;
  const f = await fixture(t, { status: () => code });
  t.after(() => rmSync(f.dir, { recursive: true }));
  const phone = device('phone');
  assert.equal((await f.json('POST', '/api/alerts/test', { endpoint: phone.subscription.endpoint })).status, 404);
  await f.json('POST', '/api/alerts/subscriptions', phone.subscription);
  assert.equal((await f.json('POST', '/api/alerts/test', { endpoint: phone.subscription.endpoint })).status, 204);
  assert.equal(f.calls.length, 1);
  assert.equal(phone.decrypt(f.calls[0].body).title, 'Alerts are on for this device');
  assert.equal((await f.json('POST', '/api/alerts/test', {})).status, 400);
  code = 500;
  const refused = await f.json('POST', '/api/alerts/test', { endpoint: phone.subscription.endpoint });
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), { status: 500 });
  code = 201;
  assert.equal((await f.json('DELETE', '/api/alerts/subscriptions', { endpoint: phone.subscription.endpoint })).status, 204);
  assert.equal((await f.json('DELETE', '/api/alerts/subscriptions', { endpoint: phone.subscription.endpoint })).status, 204, 'also when not subscribed');
  assert.equal((await f.json('POST', '/api/alerts/test', { endpoint: phone.subscription.endpoint })).status, 404);
  assert.equal((await f.json('DELETE', '/api/alerts/subscriptions', { endpoint: 1 })).status, 400);
});

test('a Dashboard VPN disconnect, through the real POST and report flow, sends no Alert; a later real drop does', async t => {
  const f = await fixture(t);
  t.after(() => rmSync(f.dir, { recursive: true }));
  const phone = device('phone');
  await f.json('POST', '/api/alerts/subscriptions', phone.subscription);
  const mac = (status: string) => f.report({ machine: 'mac', vpns: [{ name: 'Steeprock', status, kind: 'ppp' }] });
  await mac('connected');
  f.advance(10_000);
  assert.equal((await f.json('POST', '/api/machines/mac/vpns/Steeprock', { action: 'disconnect' })).status, 202);
  f.advance(5_000);
  await mac('disconnected'); // this report completes the command and clears `pending`
  f.advance(5_000);
  f.app.tick();
  await f.app.idle();
  assert.deepEqual(f.calls, []);
  // connected again, then it drops by itself
  f.advance(10_000); await mac('connected');
  f.advance(10_000); await mac('disconnected');
  await f.app.idle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(phone.decrypt(f.calls[0].body), { title: 'Steeprock dropped on Mac', body: 'The VPN disconnected on its own', tag: 'mac:vpn:Steeprock', machine: 'mac', quiet: false });
});

test('a restart on the same database neither repeats nor forgets Alerts, and a new device hears of the active ones', async t => {
  const first = await fixture(t);
  t.after(() => rmSync(first.dir, { recursive: true }));
  const phone = device('phone');
  await first.json('POST', '/api/alerts/subscriptions', phone.subscription);
  await first.report(first.full(95));
  await first.app.idle();
  assert.equal(first.calls.length, 1);
  await first.app.close();

  const second = await fixture(t, { dir: first.dir, now: 200_000 });
  await second.report(second.full(96));
  second.app.tick();
  await second.app.idle();
  assert.equal(second.calls.length, 0, 'still full: not repeated');

  // a new device learns of the disk that is already full
  const tablet = device('tablet');
  assert.equal((await second.json('POST', '/api/alerts/subscriptions', tablet.subscription)).status, 201);
  await second.app.idle();
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].url, tablet.subscription.endpoint);
  assert.equal(tablet.decrypt(second.calls[0].body).tag, 'pc:disk:C:');

  // and the Alert the first server fired still clears, to both devices
  second.advance(10_000);
  await second.report(second.full(40));
  await second.app.idle();
  assert.deepEqual(second.calls.slice(1).map(c => c.url).sort(), [phone.subscription.endpoint, tablet.subscription.endpoint].sort());
  assert.equal(phone.decrypt(second.calls.find(c => c.url === phone.subscription.endpoint && c !== second.calls[0])!.body).quiet, true);
});

test('a fire nobody accepted is retried and then reaches the device that subscribes in time', async t => {
  const f = await fixture(t);
  t.after(() => rmSync(f.dir, { recursive: true }));
  await f.report(f.full(95)); // nobody is subscribed yet
  await f.app.idle();
  assert.equal(f.calls.length, 0);
  const phone = device('phone');
  await f.json('POST', '/api/alerts/subscriptions', phone.subscription);
  await f.app.idle();
  assert.equal(f.calls.length, 1, 'catch-up');
  f.advance(60_000);
  f.app.tick();
  await f.app.idle();
  assert.equal(f.calls.length, 1, 'accepted by the catch-up, so no retry');
});

test('a broken VAPID file turns Alerts off: 503, no regenerating, reports still work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-alerts-')); t.after(() => rmSync(dir, { recursive: true }));
  const one = generateVapid(), two = generateVapid();
  const content = JSON.stringify({ publicKey: one.publicKey, privateKey: two.privateKey });
  writeFileSync(join(dir, 'vapid.json'), content);
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const app = createDashboard({ db: join(dir, 'test.db'), machines, collect: false, clock: () => 120_000, dist: join(dir, 'missing'), rules, fetch: async () => { throw new Error('must not be called'); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = (path: string, value: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.match(String(errors[0]?.[0]), /Alerts are off.*does not belong/);
  assert.equal((await fetch(base + '/api/alerts/key')).status, 503);
  assert.equal((await post('/api/alerts/subscriptions', device('phone').subscription)).status, 503);
  assert.equal((await post('/api/alerts/test', { endpoint: 'https://fcm.googleapis.com/x' })).status, 503);
  assert.equal((await post('/api/report', { machine: 'pc', cpu: 10, ram: { used: 1, total: 4 }, disks: [{ name: 'C:', used: 95 * GB, total: 100 * GB }] })).status, 204);
  app.tick();
  assert.equal(readFileSync(join(dir, 'vapid.json'), 'utf8'), content);
});

test('a catch-up push that lands after its Alert cleared is answered with the clear', async t => {
  const tablet = device('tablet'), phone = device('phone');
  let release!: () => void;
  const hung = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { gate: (url, nth) => (url === tablet.subscription.endpoint && nth === 0 ? hung : undefined) });
  t.after(() => rmSync(f.dir, { recursive: true }));
  await f.json('POST', '/api/alerts/subscriptions', phone.subscription);
  await f.report(f.full(95));
  await f.app.idle();
  assert.equal(f.calls.length, 1);
  // the tablet subscribes; its catch-up push hangs
  await f.json('POST', '/api/alerts/subscriptions', tablet.subscription);
  await until(() => f.calls.length === 2);
  // meanwhile the disk clears, and both clear pushes succeed
  f.advance(10_000);
  await f.report(f.full(40));
  await until(() => f.calls.length === 4);
  assert.deepEqual(f.calls.slice(2).map(c => c.url).sort(), [phone.subscription.endpoint, tablet.subscription.endpoint].sort());
  // the old fire finally lands on the tablet
  release();
  await f.app.idle();
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[4].url, tablet.subscription.endpoint);
  assert.deepEqual(tablet.decrypt(f.calls[4].body), { title: `C: on PC is below 85\u202f%`, body: 'Now 40\u202f%', tag: 'pc:disk:C:', machine: 'pc', quiet: true });
  assert.equal('gen' in tablet.decrypt(f.calls[4].body), false, 'the generation is not pushed');
  // nothing is left to retry
  f.advance(120_000);
  f.app.tick();
  await f.app.idle();
  assert.equal(f.calls.length, 5);
});

test('an older clear acknowledged late does not hide a newer one, and a stale clear is answered with the newest notification', async t => {
  const phone = device('phone');
  let release!: () => void;
  const hung = new Promise<void>(resolve => { release = resolve; });
  // phone's calls: 0 fire (ok), 1 clear (hangs), 2 fire (ok), 3 clear (refused), then ok
  const f = await fixture(t, {
    rules: { ...rules, cooldown: 0 },
    gate: (url, nth) => (nth === 1 && url === phone.subscription.endpoint ? hung : undefined),
    status: (_url, call) => (call === 3 ? 500 : 201),
  });
  t.after(() => rmSync(f.dir, { recursive: true }));
  t.mock.method(console, 'error', () => {});
  await f.json('POST', '/api/alerts/subscriptions', phone.subscription);
  await f.report(f.full(95)); await until(() => f.calls.length === 1);
  f.advance(10_000); await f.report(f.full(40)); await until(() => f.calls.length === 2); // clear: hangs
  f.advance(10_000); await f.report(f.full(95)); await until(() => f.calls.length === 3);
  f.advance(10_000); await f.report(f.full(40)); await until(() => f.calls.length === 4); // newest clear: refused
  release(); // the first clear is accepted at last
  await f.app.idle();
  // the stale acknowledgement is answered with the newest clear; that one is accepted, so the Alert is settled
  assert.equal(f.calls.length, 5);
  assert.equal(phone.decrypt(f.calls[4].body).quiet, true);
  assert.equal(phone.decrypt(f.calls[4].body).title, `C: on PC is below 85\u202f%`);
  f.advance(120_000);
  f.app.tick();
  await f.app.idle();
  assert.equal(f.calls.length, 5, 'no retry: the newest clear was accepted');
});
