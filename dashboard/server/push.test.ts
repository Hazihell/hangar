import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedEndpoint, encrypt, generateVapid, loadOrCreateVapid, send, validSubscription, vapidHeader, VAPID_SUBJECT } from './push.ts';

const b = (text: string) => Buffer.from(text.replace(/\s/g, ''), 'base64url');

// RFC 8291 Appendix A
const vector = {
  plaintext: b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPublic: b('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: b('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  ciphertext: b('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'),
};

test('encrypt reproduces the RFC 8291 Appendix A message byte for byte', () => {
  const body = encrypt(vector.plaintext, { keys: { p256dh: vector.uaPublic, auth: vector.auth } }, {
    salt: vector.salt,
    ephemeral: { privateKey: vector.asPrivate, publicKey: vector.asPublic },
  });
  assert.equal(vector.header.length, 86);
  assert.deepEqual(body, Buffer.concat([vector.header, vector.ciphertext]));
});

test('encrypt with fresh keys differs each time and frames one record', async () => {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  const sub = { keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
  const one = encrypt(Buffer.from('hello'), sub), two = encrypt(Buffer.from('hello'), sub);
  assert.notDeepEqual(one, two);
  assert.equal(one.readUInt32BE(16), 4096);
  assert.equal(one[20], 65);
  assert.equal(one.length, 86 + 'hello'.length + 1 + 16);
  assert.throws(() => encrypt(Buffer.alloc(4000), sub), /too large/);
});

test('the VAPID key pair is made once, saved with mode 600, and read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const path = join(dir, 'nested', 'state', 'vapid.json');
    const keys = loadOrCreateVapid(path);
    assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(keys.publicKey, 'base64url')[0], 4);
    assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), keys);
    assert.deepEqual(loadOrCreateVapid(path), keys);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a loaded VAPID file is tightened to mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const path = join(dir, 'vapid.json');
    const keys = generateVapid();
    writeFileSync(path, JSON.stringify(keys), { mode: 0o644 });
    chmodSync(path, 0o644);
    assert.deepEqual(loadOrCreateVapid(path), keys);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a broken VAPID file fails loudly and is left alone, never regenerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const path = join(dir, 'vapid.json');
    const one = generateVapid(), two = generateVapid();
    const cases: [string, string][] = [
      ['mismatched pair', JSON.stringify({ publicKey: one.publicKey, privateKey: two.privateKey })],
      ['not JSON', '{ nope'],
      ['missing key', JSON.stringify({ publicKey: one.publicKey })],
      ['short private key', JSON.stringify({ publicKey: one.publicKey, privateKey: 'AAAA' })],
      ['zero scalar', JSON.stringify({ publicKey: one.publicKey, privateKey: Buffer.alloc(32).toString('base64url') })],
      ['compressed point', JSON.stringify({ publicKey: Buffer.alloc(33, 2).toString('base64url'), privateKey: one.privateKey })],
    ];
    for (const [label, content] of cases) {
      writeFileSync(path, content);
      assert.throws(() => loadOrCreateVapid(path), /not a usable VAPID key file/, label);
      assert.equal(readFileSync(path, 'utf8'), content, label);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('the VAPID header carries an ES256 JWT that the public key verifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const keys = loadOrCreateVapid(join(dir, 'vapid.json'));
    const now = Date.UTC(2026, 9, 16, 9, 30);
    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc?x=1', keys, VAPID_SUBJECT, now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    assert.ok(match, header);
    const [, head, claims, signature, k] = match;
    assert.equal(k, keys.publicKey);
    assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
    const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
    assert.equal(body.aud, 'https://fcm.googleapis.com');
    assert.equal(body.sub, VAPID_SUBJECT);
    assert.ok(body.exp > now / 1000 && body.exp <= now / 1000 + 12 * 3600);
    assert.equal(Buffer.from(signature, 'base64url').length, 64);
    const point = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.equal(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    assert.equal(verify('sha256', Buffer.from(`${head}.${claims}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), false);
  } finally { rmSync(dir, { recursive: true }); }
});

function subscription() {
  const ua = createECDH('prime256v1'); ua.generateKeys();
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
}

test('send posts an encrypted body with the Web Push headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const vapid = loadOrCreateVapid(join(dir, 'vapid.json'));
    const sub = subscription();
    const calls: any[] = [];
    const fetch = async (url: string, init: any) => { calls.push({ url, init }); return { status: 201, ok: true }; };
    const result = await send(sub, { title: 'x' }, { vapid, fetch, urgency: 'normal', ttl: 60 });
    assert.deepEqual(result, { ok: true, status: 201, gone: false });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, sub.endpoint);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(init.headers['Content-Type'], 'application/octet-stream');
    assert.equal(init.headers.TTL, '60');
    assert.equal(init.headers.Urgency, 'normal');
    assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
    assert.ok(Buffer.isBuffer(init.body));
    assert.equal(init.body.length, 86 + JSON.stringify({ title: 'x' }).length + 1 + 16);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.redirect, 'manual');
    await send(sub, {}, { vapid, fetch });
    assert.equal(calls[1].init.headers.Urgency, 'high');
    assert.equal(calls[1].init.headers.TTL, '86400');
  } finally { rmSync(dir, { recursive: true }); }
});

test('send maps statuses and network errors without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const vapid = loadOrCreateVapid(join(dir, 'vapid.json'));
    const sub = subscription();
    const status = (code: number) => send(sub, {}, { vapid, fetch: async () => ({ status: code, ok: code < 300 }) });
    assert.deepEqual(await status(201), { ok: true, status: 201, gone: false });
    assert.deepEqual(await status(404), { ok: false, status: 404, gone: true });
    assert.deepEqual(await status(410), { ok: false, status: 410, gone: true });
    assert.deepEqual(await status(500), { ok: false, status: 500, gone: false });
    for (const code of [301, 302, 307, 308]) assert.deepEqual(await status(code), { ok: false, status: code, gone: false, error: 'redirects are not followed' });
    const failed = await send(sub, {}, { vapid, fetch: async () => { throw new Error('connect ECONNREFUSED'); } });
    assert.deepEqual(failed, { ok: false, status: 0, gone: false, error: 'connect ECONNREFUSED' });
  } finally { rmSync(dir, { recursive: true }); }
});

test('validSubscription accepts browser subscriptions and rejects the rest', () => {
  const good = subscription();
  assert.equal(validSubscription(good), true);
  assert.equal(validSubscription({ ...good, expirationTime: null }), true);
  const bad = (patch: any) => validSubscription({ ...good, ...patch });
  assert.equal(bad({ endpoint: 'http://push.example.com/x' }), false);
  assert.equal(bad({ endpoint: 'not a url' }), false);
  assert.equal(bad({ endpoint: 'https://fcm.googleapis.com/' + 'a'.repeat(2048) }), false);
  assert.equal(bad({ endpoint: 5 }), false);
  assert.equal(bad({ keys: { ...good.keys, auth: Buffer.alloc(15).toString('base64url') } }), false);
  assert.equal(bad({ keys: { ...good.keys, p256dh: Buffer.alloc(65, 1).toString('base64url') } }), false);
  const compressed = Buffer.from(good.keys.p256dh, 'base64url'); compressed[0] = 2;
  assert.equal(bad({ keys: { ...good.keys, p256dh: compressed.toString('base64url') } }), false);
  const offCurve = Buffer.from(good.keys.p256dh, 'base64url'); offCurve[64] ^= 1;
  assert.equal(bad({ keys: { ...good.keys, p256dh: offCurve.toString('base64url') } }), false);
  assert.equal(bad({ keys: undefined }), false);
  assert.equal(validSubscription(null), false);
  assert.equal(validSubscription('x'), false);
});

test('only known push services on port 443 without credentials are accepted', () => {
  const good = subscription();
  const at = (endpoint: string) => validSubscription({ ...good, endpoint });
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://android.googleapis.com/gcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://updates-autopush.stage.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://api.push.apple.com/3/device/abc',
    'https://wns2-par02p.notify.windows.com/?token=abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
    'https://FCM.GoogleAPIs.com/fcm/send/abc',
  ]) assert.equal(at(endpoint), true, endpoint);
  for (const endpoint of [
    'https://127.0.0.1:9443/internal',
    'https://localhost/x',
    'https://[::1]/x',
    'https://192.168.1.10/x',
    'https://push.example.com/x',
    'https://fcm.googleapis.com.evil.test/x',
    'https://evilfcm.googleapis.com/x',
    'https://fcm.googleapis.com@evil.test/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://fcm.googleapis.com./x',
    'https://notify.windows.com/x',
    'https://push.apple.com/x',
    'https://evil-push.apple.com.test/x',
    'https://pushxapple.com/x',
    'https://x.notify.windows.com.evil.test/x',
    'http://fcm.googleapis.com/x',
    'wss://fcm.googleapis.com/x',
  ]) assert.equal(at(endpoint), false, endpoint);
  assert.equal(allowedEndpoint(42), false);
});

test('send refuses an endpoint outside the allowlist without calling fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-vapid-'));
  try {
    const vapid = loadOrCreateVapid(join(dir, 'vapid.json'));
    let called = false;
    const result = await send({ ...subscription(), endpoint: 'https://127.0.0.1:9443/internal' }, {}, { vapid, fetch: async () => { called = true; return { status: 201, ok: true }; } });
    assert.deepEqual(result, { ok: false, status: 0, gone: false, error: 'endpoint is not a known push service' });
    assert.equal(called, false);
  } finally { rmSync(dir, { recursive: true }); }
});
