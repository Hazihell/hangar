import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from './server.ts';
import { parseList, failureLine } from './rc.ts';
import type { Exec } from './vpn.ts';

const machines = [
  { id: 'pc', name: 'Stormtrooper', os: 'windows', collector: 'wsl' },
  { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' },
  { id: 'other', name: 'Other', os: 'macos', collector: 'mac' },
];
const A = '/home/roger/Dev/a', B = '/home/roger/Dev/b', C = '/home/roger/Dev/with space';
const folder = (path: unknown, extra: object = {}) => ({ path, mode: 'worktree', state: 'running', ...extra });
const listing = (folders: unknown[], candidates: unknown[]) => JSON.stringify({ folders, candidates });

async function fixture(t: any, options: { checks?: boolean; hangar?: string; real?: boolean } = {}) {
  let now = 120_000;
  const calls: { file: string; args: string[]; options: any; done: Parameters<Exec>[3] }[] = [];
  const kills: [number, string][] = [];
  const app = createDashboard({ db: ':memory:', machines, collect: false, rcChecks: options.checks ?? true, clock: () => now, hosts: [], hangar: options.hangar ?? '/repo/bin/hangar',
    ...(options.real ? {} : { kill: (pid: number, signal: string) => { kills.push([pid, signal]); } }),
    ...(options.real ? {} : { exec(file: string, args: string[], o: any, done: Parameters<Exec>[3]) { calls.push({ file, args, options: o, done }); return { pid: 4000 + calls.length }; } }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.listening ? app.close() : undefined);
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const send = (path: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const rc = (id: string, action: unknown, path: unknown, headers?: Record<string, string>) => send(`/api/machines/${id}/rc`, { action, path }, headers);
  const online = (...ids: string[]) => Promise.all(ids.map(machine => fetch(base + '/api/report', { method: 'POST', body: JSON.stringify({ machine, cpu: 1, ram: { used: 1, total: 2 }, disks: [] }) })));
  const get = async (id = 'pc') => (await (await fetch(base + '/api/machines')).json()).machines.find((m: any) => m.id === id);
  const state = async () => (await get()).remoteControl;
  /** Answers the newest call, then lets the server react. */
  const reply = (error: any, stdout = '', stderr = '') => calls.at(-1)!.done(error, stdout, stderr);
  const advance = async (ms: number, ...ids: string[]) => { now += ms; await online(...ids); app.tick(); };
  /** The first list is due 5 s after the server starts: answer it. */
  const seed = async (folders: unknown[], candidates: unknown[]) => { await advance(5000, 'pc'); assert.deepEqual(calls.at(-1)!.args, ['rc', 'list', '--json']); reply(null, listing(folders, candidates)); };
  return { app, base, calls, kills, send, rc, online, get, state, reply, advance, seed, jump: (ms: number) => { now += ms; } };
}

/** Machine events from the stream, one at a time. */
async function events(base: string, t: any) {
  const abort = new AbortController(); t.after(() => abort.abort());
  const reader = (await fetch(base + '/api/events', { signal: abort.signal })).body!.getReader();
  const decoder = new TextDecoder(); let buffer = '';
  return async () => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) { const chunk = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = chunk.split('\n').find(l => l.startsWith('data: ')); if (data) return JSON.parse(data.slice(6)); continue; }
      const { value, done } = await reader.read(); assert.equal(done, false); buffer += decoder.decode(value, { stream: true });
    }
  };
}

test('the list keeps valid folders and candidates in order and drops the rest', () => {
  const parsed = parseList(listing([
    folder(A), folder(A, { state: 'stopped' }),                       // duplicate
    folder('relative/dir'), folder('/home/roger/Dev/b\u0007'),         // not absolute, control character
    folder('/home/roger/Dev/c', { mode: 'shared' }), folder('/home/roger/Dev/d', { state: 'on' }),
    folder(5), folder(undefined), 'nonsense', null,
    folder('/home/roger/Dev/e', { mode: 'same-dir', state: 'failing' }),
  ], [B, 'rel', '/home/x\ny', 4, null, B, C]));
  assert.deepEqual(parsed, {
    folders: [folder(A), folder('/home/roger/Dev/e', { mode: 'same-dir', state: 'failing' })],
    candidates: [B, C],
  });
  assert.deepEqual(parseList('{"folders":[],"candidates":[]}'), { folders: [], candidates: [] });
});

test('a list that is not the document is refused, noise and all', () => {
  for (const bad of ['', 'hangar: help text', '[]', 'null', '{"folders":{},"candidates":[]}', '{"folders":[]}', '{"candidates":[]}', '{"folders":[],"candidates":"x"}', 'Last login: today\n{"folders":[],"candidates":[]}']) assert.equal(parseList(bad), null, bad);
});

test('a failure is the last line of output, without the mark hangar prints before it', () => {
  assert.equal(failureLine('  \u001b[31mfail\u001b[0m  /home/roger/Dev/a didn’t start\u0007\n\n', 'warn  something'), '/home/roger/Dev/a didn’t start');
  assert.equal(failureLine('   ok    first\n  fail  second\n  fail  third\n', ''), 'third');
  assert.equal(failureLine('', 'only on stderr\n'), 'only on stderr');
  assert.equal(failureLine('  fail  ' + 'x'.repeat(500), '').length, 160 - 'fail  '.length);
  assert.equal(failureLine('', ''), '');
  assert.equal(failureLine(undefined, undefined), '');
});

test('only the PC has Remote Control in its payload', async t => {
  const f = await fixture(t); await f.online('pc', 'mac');
  assert.deepEqual((await f.get()).remoteControl, { folders: [], candidates: [], checkedAt: null, pending: null, error: null });
  assert.equal('remoteControl' in await f.get('mac'), false);
  assert.equal('remoteControl' in await f.get('other'), false);
});

test('the first list runs hangar locally a few seconds after the server starts, then every 30 s while Online', async t => {
  const f = await fixture(t); await f.online('pc', 'mac');
  await f.advance(4_000, 'pc', 'mac'); assert.equal(f.calls.length, 0);
  await f.advance(1_000, 'pc', 'mac');
  assert.equal(f.calls.length, 1, 'only the PC runs hangar rc; the Mac never does');
  assert.deepEqual([f.calls[0].file, f.calls[0].args, f.calls[0].options.timeout], ['/repo/bin/hangar', ['rc', 'list', '--json'], 20_000]);
  await f.advance(10_000, 'pc'); assert.equal(f.calls.length, 1, 'still answering');
  f.reply(null, listing([folder(A)], [B]));
  assert.deepEqual(await f.state(), { folders: [folder(A)], candidates: [B], checkedAt: 135_000, pending: null, error: null });
  await f.advance(29_000, 'pc'); assert.equal(f.calls.length, 1);
  await f.advance(1_000, 'pc'); assert.equal(f.calls.length, 2);
  f.reply(null, listing([folder(A), folder(B, { state: 'starting' })], []));
  assert.deepEqual((await f.state()).folders.map((x: any) => x.state), ['running', 'starting']);
  assert.equal((await f.state()).checkedAt, 165_000);
  // Offline: skipped, and listed again as soon as the Machine is back
  f.jump(60_000); f.app.tick(); assert.equal(f.calls.length, 2);
  await f.advance(1_000, 'pc'); assert.equal(f.calls.length, 3);
});

test('a failed or unreadable list keeps the previous result and is tried again in 30 s', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B]);
  const before = await f.state();
  const failures: [any, string, string][] = [[{ code: 1 }, '', 'systemctl: not found'], [null, 'Usage: hangar rc', ''], [null, '{"folders":{}}', ''], [{ killed: true }, '', '']];
  for (const [error, out, err] of failures) {
    await f.advance(30_000, 'pc'); f.reply(error, out, err);
    assert.deepEqual(await f.state(), before);
  }
  assert.equal(f.calls.length, 5);
});

test('a changed list sends a machine event', async t => {
  const f = await fixture(t); await f.online('pc');
  const next = await events(f.base, t);
  await f.seed([folder(A)], [B]);
  let e = await next(); while (e.remoteControl.folders.length === 0) e = await next();
  assert.deepEqual(e.remoteControl.folders, [folder(A)]);
  await f.advance(30_000, 'pc'); f.reply(null, listing([folder(A, { state: 'failing' })], [B]));
  while ((e = await next()).remoteControl.folders[0].state !== 'failing');
});

test('Remote Control posts reject bad requests, unknown Machines, cross-origin and non-JSON', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B, C]);
  assert.equal((await f.rc('missing', 'add', B)).status, 404);
  assert.equal((await f.rc('mac', 'add', B)).status, 404, 'a Machine without Remote Control');
  assert.equal((await f.rc('other', 'remove', A)).status, 404);
  assert.equal((await f.rc('pc', 'add', B, {})).status, 400);
  assert.equal((await f.rc('pc', 'add', B, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await f.send('/api/machines/pc/rc', '{', { 'Content-Type': 'application/json' })).status, 400);
  for (const body of [[], null, 'add', {}, { action: 'add' }, { path: B }, { action: 'restart', path: B }, { action: 'add', path: 5 }, { action: ['add'], path: B }, { action: 'add', path: null }]) assert.equal((await f.send('/api/machines/pc/rc', body)).status, 400, JSON.stringify(body));
  // The whitelist: an add must be a candidate, a remove a served folder
  for (const [action, path] of [['add', '/etc'], ['add', A], ['add', '/home/roger/Dev/b/'], ['add', '/home/roger/Dev/b/../a'], ['add', 'b'], ['add', ''], ['add', `${B}\n`], ['remove', B], ['remove', '/etc'], ['remove', `${A}/`], ['remove', '..']]) assert.equal((await f.rc('pc', action, path)).status, 400, `${action} ${path}`);
  const cross = { 'Content-Type': 'application/json', Origin: 'https://attacker.example' };
  assert.equal((await f.rc('pc', 'add', B, cross)).status, 403);
  assert.equal((await f.rc('pc', 'add', B, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const status = await new Promise<number>(resolve => { const r = request(f.base + '/api/machines/pc/rc', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' } }, res => resolve(res.statusCode!)); r.end(JSON.stringify({ action: 'add', path: B })); });
  assert.equal(status, 403);
  assert.equal(f.calls.length, 1, 'only the first list ran');
  assert.deepEqual((await f.state()).pending, null);
});

test('an Offline Machine and a pending add or remove answer 409', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B, C]);
  f.jump(31_000);
  assert.equal((await f.rc('pc', 'add', B)).status, 409, 'Offline');
  assert.equal((await f.rc('pc', 'remove', A)).status, 409);
  assert.equal(f.calls.length, 1);
  await f.online('pc');
  assert.equal((await f.rc('pc', 'add', B)).status, 202);
  assert.equal((await f.rc('pc', 'add', C)).status, 409, 'one at a time');
  assert.equal((await f.rc('pc', 'remove', A)).status, 409);
  assert.equal((await f.rc('pc', 'add', '/etc')).status, 400, 'a bad path is still a bad request while pending');
});

test('an add runs hangar rc add with the path as one argument, shows pending, then lists again', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B, C]);
  const next = await events(f.base, t);
  const response = await f.rc('pc', 'add', C);
  assert.equal(response.status, 202);
  assert.match(response.headers.get('content-type')!, /json/);
  const body = await response.json();
  assert.deepEqual(body, { folders: [folder(A)], candidates: [B, C], checkedAt: 125_000, pending: { action: 'add', path: C }, error: null });
  let e = await next(); while (!e.remoteControl.pending) e = await next();
  assert.deepEqual(e.remoteControl.pending, { action: 'add', path: C });
  assert.deepEqual([f.calls[1].file, f.calls[1].args, f.calls[1].options.detached, f.calls[1].options.timeout], ['/repo/bin/hangar', ['rc', 'add', C], true, 0]);
  f.reply(null, `  ok    ${C} served; new sessions: worktree\n`);
  assert.equal((await f.state()).pending, null);
  assert.equal((await f.state()).error, null);
  assert.deepEqual(f.calls.at(-1)!.args, ['rc', 'list', '--json'], 'the list is read again right away');
  f.reply(null, listing([folder(A), folder(C, { state: 'starting' })], [B]));
  assert.deepEqual(await f.state(), { folders: [folder(A), folder(C, { state: 'starting' })], candidates: [B], checkedAt: 120_000 + 5000, pending: null, error: null });
  while ((e = await next()).remoteControl.folders.length !== 2);
});

test('a remove runs hangar rc remove on a served folder', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A), folder(B)], []);
  assert.equal((await f.rc('pc', 'remove', B)).status, 202);
  assert.deepEqual([f.calls[1].file, f.calls[1].args], ['/repo/bin/hangar', ['rc', 'remove', B]]);
  assert.deepEqual((await f.state()).pending, { action: 'remove', path: B });
  f.reply(null, `  ok    ${B} no longer served`);
  f.reply(null, listing([folder(A)], [B]));
  assert.deepEqual((await f.state()).folders, [folder(A)]);
  assert.deepEqual((await f.state()).candidates, [B]);
});

test('a failing add shows the last line of its output and nothing of the command; the next one clears it', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B, C]);
  await f.rc('pc', 'add', B);
  f.reply({ code: 1, message: 'Command failed: /repo/bin/hangar rc add --secret' }, '  \u001b[31mfail\u001b[0m  /home/roger/Dev/b didn’t start; check the journal\u0007\n\n', 'warn  something');
  let state = await f.state();
  assert.equal(state.pending, null);
  assert.equal(state.error, '/home/roger/Dev/b didn’t start; check the journal');
  assert.doesNotMatch(JSON.stringify(state), /secret/);
  assert.deepEqual(f.calls.at(-1)!.args, ['rc', 'list', '--json'], 'a failure is followed by a list as well');
  f.reply(null, listing([folder(A)], [B, C]));
  assert.equal((await f.state()).error, '/home/roger/Dev/b didn’t start; check the journal', 'a list does not clear it');
  assert.equal((await f.rc('pc', 'add', B)).status, 202);
  assert.equal((await f.state()).error, null);
  f.reply({ code: 7 });
  assert.equal((await f.state()).error, 'Adding the folder failed (exit code 7)');
  f.reply(null, listing([folder(A)], [B, C]));
  await f.rc('pc', 'remove', A); f.reply({ code: 1 }, '', 'systemctl: it broke');
  assert.equal((await f.state()).error, 'systemctl: it broke');
  f.reply(null, listing([folder(A)], [B, C]));
  await f.rc('pc', 'remove', A); f.reply({ code: 1 }, '', '');
  assert.equal((await f.state()).error, 'Removing the folder failed (exit code 1)');
  f.reply(null, listing([folder(A)], [B, C]));
  await f.rc('pc', 'add', B); f.reply({ code: 1 }, 'x'.repeat(400));
  assert.equal((await f.state()).error.length, 160);
});

test('an add that throws on start reports a generic failure, without the command line', async t => {
  let thrown = false;
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B]);
  const original = f.calls.push.bind(f.calls);
  f.calls.push = (...args: any[]) => { if (args[0].args[1] === 'add' && !thrown) { thrown = true; throw new Error('Command failed: /secret/hangar rc add'); } return original(...args); };
  assert.equal((await f.rc('pc', 'add', B)).status, 202);
  const state = await f.state();
  assert.equal(state.pending, null);
  assert.equal(state.error, 'Adding the folder failed (exit code 1)');
  assert.doesNotMatch(JSON.stringify(state), /secret/);
});

test('an add running 60 s ends with an error and a fresh list; the late callback is ignored', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B]);
  await f.rc('pc', 'add', B);
  const add = f.calls.length - 1;
  await f.advance(60_000 - 1, 'pc');
  assert.notEqual((await f.state()).pending, null);
  await f.advance(1, 'pc');
  const state = await f.state();
  assert.equal(state.pending, null);
  assert.equal(state.error, 'Timed out after 60 seconds');
  assert.deepEqual(f.calls.at(-1)!.args, ['rc', 'list', '--json']);
  f.calls[add].done({ killed: true, code: null }, '', '');
  assert.equal((await f.state()).error, 'Timed out after 60 seconds', 'the late exit changes nothing the page sees');
});

test('exec reporting a kill by timeout is also an error', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B]);
  await f.rc('pc', 'add', B);
  f.reply({ killed: true, signal: 'SIGTERM' }, 'noise');
  assert.equal((await f.state()).error, 'Timed out after 60 seconds');
});

test('after the 60 s limit the command is stopped with its whole group, and no second one starts until it has exited', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed([folder(A)], [B, C]);
  await f.rc('pc', 'add', B);
  const add = f.calls.length - 1, pid = 4000 + f.calls.length;
  await f.advance(60_000, 'pc');
  assert.deepEqual(f.kills, [[-pid, 'SIGTERM'], [pid, 'SIGTERM']]);
  assert.equal((await f.state()).pending, null);
  assert.equal((await f.rc('pc', 'add', C)).status, 409, 'still running');
  await f.advance(9_000, 'pc'); assert.equal(f.kills.length, 2, 'a grace period before KILL');
  await f.advance(1_000, 'pc');
  assert.deepEqual(f.kills.slice(2), [[-pid, 'SIGKILL'], [pid, 'SIGKILL']]);
  await f.advance(60_000, 'pc'); assert.equal(f.kills.length, 4, 'KILL is sent once');
  assert.equal((await f.rc('pc', 'add', C)).status, 409, 'until the process has actually exited');
  f.calls[add].done({ killed: true, signal: 'SIGKILL' }, '', '');
  assert.equal((await f.rc('pc', 'add', C)).status, 202);
});

test('a real command that ignores SIGTERM and has descendants is gone after the limit and the grace period', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-rc-kill-')); t.after(() => rmSync(dir, { recursive: true }));
  const script = join(dir, 'hangar'), pidfile = join(dir, 'sleep.pid');
  writeFileSync(script, `#!/bin/sh\nif [ "$2" = list ]; then echo '${listing([], [B])}'; exit 0; fi\ntrap '' TERM\nsleep 60 &\necho $! > ${pidfile}\nwait\n`);
  chmodSync(script, 0o755);
  const f = await fixture(t, { real: true, hangar: script }); await f.online('pc');
  const until = async (ok: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200 && !(await ok()); i++) await new Promise(r => setTimeout(r, 25)); assert.equal(await ok(), true); };
  const written = () => { try { return Number(readFileSync(pidfile, 'utf8')); } catch { return 0; } };
  await f.advance(5000, 'pc'); await until(async () => (await f.state()).candidates.length === 1);
  assert.equal((await f.rc('pc', 'add', B)).status, 202);
  await until(() => written() > 0);
  const sleeper = written(), alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let last = sleeper;   // whichever command started last; the folder with the pid file is gone by the time cleanup runs
  t.after(() => { try { process.kill(last, 'SIGKILL'); } catch {} });
  await f.advance(60_000, 'pc');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(alive(sleeper), true, 'SIGTERM is ignored');
  assert.equal((await f.rc('pc', 'add', B)).status, 409);
  await f.advance(10_000, 'pc');
  await until(() => !alive(sleeper));   // the real process group received SIGKILL, descendants included
  let status = 409;
  for (let i = 0; i < 200 && status !== 202; i++) { status = (await f.rc('pc', 'add', B)).status; if (status !== 202) await new Promise(r => setTimeout(r, 25)); }
  assert.equal(status, 202, 'a new command starts once the old one has exited');
  await until(() => written() > 0 && written() !== sleeper); last = written();
});
