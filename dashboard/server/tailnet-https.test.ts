import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join } from 'node:path';
import { splitPem, startTailnetHttps, tailnetAddress } from './tailnet-https.ts';
import type { Exec } from './vpn.ts';
test('only tailnet addresses count as the tailnet', () => {
  for (const a of ['100.124.13.6', '::ffff:100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::872c:d07']) assert.equal(tailnetAddress(a), true, a);
  for (const a of ['192.168.3.49', '100.63.0.1', '100.128.0.1', '127.0.0.1', '::1', 'fe80::1', undefined]) assert.equal(tailnetAddress(a), false, String(a));
});
test('the certificate chain and key are told apart in tailscale cert output', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n-----BEGIN EC PRIVATE KEY-----\nK\n-----END EC PRIVATE KEY-----\n';
  assert.deepEqual(splitPem(pem), { cert: '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n', key: '-----BEGIN EC PRIVATE KEY-----\nK\n-----END EC PRIVATE KEY-----\n' });
  assert.equal(splitPem('-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n'), null);
  assert.equal(splitPem(''), null);
});
function selfSigned(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
  } finally { rmSync(dir, { recursive: true }); }
}
test('serves the Dashboard over HTTPS with the certificate for the tailnet name, once Tailscale answers', async t => {
  const name = 'pc.example.ts.net', { cert, key } = selfSigned(name), calls: string[][] = [];
  let up = false;
  const exec: Exec = (file, args, _options, callback) => {
    calls.push([file, ...args]);
    if (args[0] === 'status') up ? callback(null, JSON.stringify({ Self: { DNSName: name + '.' } }), '') : callback(new Error('not running'), '', '');
    else callback(null, cert + key, '');
    return undefined;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const https = startTailnetHttps({ tailscale: 'tailscale.exe', exec, port: 0, host: '127.0.0.1', accept: () => true, log: () => {}, listener: (req, res) => res.end(`hello ${req.headers.host}`) });
  t.after(() => https.close());
  assert.deepEqual(calls, [['tailscale.exe', 'status', '--json']]);
  assert.equal(https.server.listening, false);
  // Tailscale isn't up yet at boot, so it asks again a minute later.
  up = true; calls.length = 0;
  t.mock.timers.tick(60_000);
  assert.deepEqual(calls, [['tailscale.exe', 'status', '--json'], ['tailscale.exe', 'cert', '--cert-file', '-', '--key-file', '-', name]]);
  await once(https.server, 'listening');
  const port = (https.server.address() as any).port;
  const body = await new Promise<string>((resolve, reject) => {
    request({ host: '127.0.0.1', port, servername: name, ca: cert, headers: { host: name } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }).on('error', reject).end();
  });
  assert.equal(body, `hello ${name}`);
  // Then once a day, to pick up Tailscale's renewals.
  calls.length = 0;
  t.mock.timers.tick(24 * 60 * 60_000 - 1);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
});
test('drops connections that did not arrive over the tailnet', async t => {
  const name = 'pc.example.ts.net', { cert, key } = selfSigned(name);
  const exec: Exec = (_file, args, _options, callback) => { callback(null, args[0] === 'status' ? JSON.stringify({ Self: { DNSName: name } }) : cert + key, ''); return undefined; };
  let served = false;
  const https = startTailnetHttps({ tailscale: 'tailscale.exe', exec, port: 0, host: '127.0.0.1', log: () => {}, listener: (_req, res) => { served = true; res.end(); } });
  t.after(() => https.close());
  await once(https.server, 'listening');
  const socket = connect({ host: '127.0.0.1', port: (https.server.address() as any).port, servername: name, ca: cert });
  let secured = false;
  socket.on('secureConnect', () => { secured = true; }).on('error', () => {});
  await new Promise(resolve => socket.on('close', resolve));
  assert.equal(secured, false);
  assert.equal(served, false);
});
