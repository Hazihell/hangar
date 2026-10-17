import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from './server.ts';
import { parseOutdated, lastLine, readT3Threads } from './updates.ts';
import type { Exec } from './vpn.ts';

const machines = [
  { id: 'pc', name: 'Stormtrooper', os: 'windows', collector: 'wsl' },
  { id: 'mac', name: 'Mac', os: 'macos', collector: 'mac', ssh: 'user@mac' },
  { id: 'other', name: 'Other', os: 'macos', collector: 'mac' },
];
const item = (id: string, extra: object = {}) => ({ id, name: id.toUpperCase(), current: '1.0.0', latest: '1.1.0', available: true, blocked: null, ...extra });
const outdated = (...items: object[]) => JSON.stringify({ items });

async function fixture(t: any, options: { checks?: boolean; t3Db?: string; throws?: boolean; hangar?: string; real?: boolean } = {}) {
  let now = 120_000;
  const calls: { file: string; args: string[]; options: any; done: Parameters<Exec>[3] }[] = [];
  const kills: [number, string][] = [];
  const app = createDashboard({ db: ':memory:', machines, collect: false, updateChecks: options.checks ?? false, clock: () => now, hosts: [], hangar: options.hangar ?? '/repo/bin/hangar', t3Db: options.t3Db ?? '/nonexistent/statev2.sqlite',
    ...(options.real ? {} : { kill: (pid: number, signal: string) => { kills.push([pid, signal]); } }),
    ...(options.real ? {} : { exec(file: string, args: string[], o: any, done: Parameters<Exec>[3]) { calls.push({ file, args, options: o, done }); if (options.throws) throw new Error('Command failed: /secret/command line'); return { pid: 4000 + calls.length }; } }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.listening ? app.close() : undefined);
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const send = (path: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const update = (id: string, items: unknown, headers?: Record<string, string>) => send(`/api/machines/${id}/updates`, { items }, headers);
  const check = (id: string) => send(`/api/machines/${id}/updates/check`, {});
  const online = (...ids: string[]) => Promise.all(ids.map(machine => fetch(base + '/api/report', { method: 'POST', body: JSON.stringify({ machine, cpu: 1, ram: { used: 1, total: 2 }, disks: [] }) })));
  const get = async (id = 'pc') => (await (await fetch(base + '/api/machines')).json()).machines.find((m: any) => m.id === id);
  const updates = async (id = 'pc') => (await get(id)).updates;
  /** Answers the newest outstanding call with `stdout`, then lets the server react. */
  const answer = (index: number, error: any, stdout = '', stderr = '') => calls[index].done(error, stdout, stderr);
  const seed = async (id: string, ...items: object[]) => { const n = calls.length; assert.equal((await check(id)).status, 202); answer(n, null, outdated(...items)); };
  return { app, base, calls, kills, send, update, check, online, get, updates, answer, seed, advance: async (ms: number, ...ids: string[]) => { now += ms; await online(...ids); app.tick(); }, jump: (ms: number) => { now += ms; } };
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

test('outdated JSON keeps valid items in order and drops the rest', () => {
  const parsed = parseOutdated(outdated(
    item('hangar', { current: 'abc1234', latest: 'def5678', behind: 3 }),
    item('claude'), item('claude', { latest: '9.9.9' }),          // duplicate
    item('unknown'), item('codex', { current: 'a b' }),            // unknown id, bad version
    item('gh', { latest: null }), item('tea', { behind: 2, blocked: 'Run `hangar update`\u0007 here' }),
    item('t3', { available: 'yes' }), 'nonsense', null,
  ));
  assert.deepEqual(parsed, [
    { id: 'claude', name: 'CLAUDE', current: '1.0.0', latest: '1.1.0', available: true, blocked: null },
    { id: 'gh', name: 'GH', current: '1.0.0', latest: null, available: false, blocked: null },
    { id: 'tea', name: 'TEA', current: '1.0.0', latest: '1.1.0', available: true, blocked: 'Run `hangar update` here' },
    { id: 'hangar', name: 'HANGAR', current: 'abc1234', latest: 'def5678', available: true, blocked: null, behind: 3 },
  ]);
  assert.equal(parseOutdated(outdated(item('hangar', { behind: -1 })))!.length, 0);
  assert.deepEqual(parseOutdated(outdated(item('hangar', { current: null, latest: null, available: true, behind: null }))), [{ id: 'hangar', name: 'HANGAR', current: null, latest: null, available: false, blocked: null, behind: null }]);
});

test('outdated JSON that is not the document is refused, and a noisy shell is tolerated', () => {
  for (const bad of ['', 'hangar: help text', '[]', '{"items":{}}', '{"items":"x"}', 'null']) assert.equal(parseOutdated(bad), null);
  assert.equal(parseOutdated('Last login: today\n' + outdated(item('claude')) + '\n')!.length, 1);
  assert.deepEqual(parseOutdated('{"items":[]}'), []);
});

test('error lines are the last non-empty line, free of terminal codes, and short', () => {
  assert.equal(lastLine('first\n\u001b[31mthe real\u0007 reason\u001b[0m\r\n\n  \n'), 'the real reason');
  assert.equal(lastLine('x'.repeat(500)).length, 160);
  assert.equal(lastLine(''), '');
  assert.equal(lastLine(undefined), '');
});

test('update endpoints reject bad requests, unknown Machines, cross-origin and non-JSON posts', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'), item('gh', { blocked: 'Needs sudo' }));
  assert.equal((await f.update('missing', ['claude'])).status, 404);
  assert.equal((await f.check('missing')).status, 404);
  assert.equal((await f.update('pc', ['claude'], {})).status, 400);
  assert.equal((await f.update('pc', ['claude'], { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await f.send('/api/machines/pc/updates/check', {}, {})).status, 400);
  assert.equal((await f.send('/api/machines/pc/updates', '{', { 'Content-Type': 'application/json' })).status, 400);
  assert.equal((await f.send('/api/machines/pc/updates', { items: 'claude' })).status, 400);
  assert.equal((await f.send('/api/machines/pc/updates', [])).status, 400);
  for (const items of [[], ['unknown'], ['claude', 'claude'], ['codex'], [1], ['t3']]) assert.equal((await f.update('pc', items)).status, 400, JSON.stringify(items));
  const cross = { 'Content-Type': 'application/json', Origin: 'https://attacker.example' };
  assert.equal((await f.update('pc', ['claude'], cross)).status, 403);
  assert.equal((await f.send('/api/machines/pc/updates/check', {}, cross)).status, 403);
  assert.equal((await f.update('pc', ['claude'], { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const status = await new Promise<number>(resolve => { const r = request(f.base + '/api/machines/pc/updates', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' } }, res => resolve(res.statusCode!)); r.end('{"items":["claude"]}'); });
  assert.equal(status, 403);
  assert.equal(f.calls.length, 1, 'only the seeding check ran');
});

test('a blocked item, an Offline Machine and a pending update answer 409', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'), item('gh', { blocked: 'Needs sudo' }));
  assert.equal((await f.update('pc', ['claude', 'gh'])).status, 409);
  assert.equal((await f.update('pc', ['gh'])).status, 409);
  assert.equal((await f.updates()).pending, null);
  assert.equal((await f.check('mac')).status, 409, 'the Mac never reported: Offline');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.update('mac', ['claude'])).status, 400, 'nothing known about an Offline Machine that was never checked');
  assert.equal((await f.update('pc', ['claude'])).status, 202);
  assert.equal((await f.update('pc', ['claude'])).status, 409);
});

test('checking runs hangar outdated locally on the PC and over SSH on the Mac, one at a time', async t => {
  const f = await fixture(t); await f.online('pc', 'mac');
  assert.equal((await f.check('pc')).status, 202);
  assert.equal((await f.check('pc')).status, 409);
  assert.equal((await f.updates()).checking, true);
  assert.equal((await f.check('mac')).status, 202);
  assert.equal((await f.check('other')).status, 409, 'a Machine the server has no way to reach');
  assert.deepEqual(f.calls.map(c => [c.file, c.args]), [
    ['/repo/bin/hangar', ['outdated', '--json']],
    ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'user@mac', '"$HOME/.local/bin/hangar" outdated --json']],
  ]);
  assert.equal(f.calls[0].options.timeout, 90_000);
  f.answer(0, null, outdated(item('claude')));
  const state = await f.updates();
  assert.deepEqual(state, { checkedAt: '1970-01-01T00:02:00.000Z', checking: false, items: [item('claude')], pending: null, error: null });
  assert.equal((await f.updates('mac')).checking, true);
  assert.deepEqual((await f.updates('other')), { checkedAt: null, checking: false, items: [], pending: null, error: null });
});

test('a failed or unreadable check keeps the previous result', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  const before = await f.updates();
  f.jump(1000);
  await f.check('pc'); f.answer(1, { code: 255 }, '', 'ssh: connect timed out');
  await f.check('pc'); f.answer(2, null, 'Usage: hangar help');
  await f.check('pc'); f.answer(3, null, '{"items":{}}');
  assert.deepEqual(await f.updates(), before);
  await f.check('pc'); assert.equal((await f.updates()).checking, true);
});

test('an update runs its ids in order, shows pending, then checks the Machine again', async t => {
  const f = await fixture(t); await f.online('pc', 'mac');
  const next = await events(f.base, t);
  await f.seed('pc', item('claude'), item('codex'), item('hangar', { behind: 2 }));
  assert.equal((await next()).updates.checking, true);
  assert.equal((await next()).updates.items.length, 3);
  f.jump(5000);
  const response = await f.update('pc', ['codex', 'claude']);
  assert.equal(response.status, 202);
  const pending = { items: ['codex', 'claude'], since: '1970-01-01T00:02:05.000Z' };
  assert.deepEqual((await response.json()).pending, pending);
  assert.deepEqual((await next()).updates.pending, pending);
  assert.deepEqual([f.calls[1].file, f.calls[1].args, f.calls[1].options.detached, f.calls[1].options.timeout], ['/repo/bin/hangar', ['update', 'codex', 'claude'], true, 0]);
  f.jump(20_000); await f.online('pc', 'mac');
  f.answer(1, null, 'lots of output\nok\n');
  for (let e = await next(); e.updates.pending; e = await next());   // reports and this end both publish
  assert.equal((await f.updates()).pending, null);
  assert.equal((await f.updates()).error, null);
  assert.deepEqual([f.calls[2].file, f.calls[2].args], ['/repo/bin/hangar', ['outdated', '--json']]);
  assert.equal((await f.updates()).checking, true);
  f.answer(2, null, outdated(item('claude', { current: '1.1.0', available: false }), item('codex', { current: '1.1.0', available: false })));
  assert.equal((await f.updates()).items.every((i: any) => !i.available), true);
  // the Mac goes over SSH
  await f.seed('mac', item('gh'), item('tea'));
  assert.equal((await f.update('mac', ['gh', 'tea'])).status, 202);
  const mac = f.calls.at(-1)!;
  assert.deepEqual([mac.file, mac.args.slice(0, 5), mac.args[5]], ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'user@mac'], '"$HOME/.local/bin/hangar" update gh tea']);
});

test('a failing update shows the last line of its output and nothing of the command; the next update clears it', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  await f.update('pc', ['claude']);
  f.answer(1, { code: 1, message: 'Command failed: /repo/bin/hangar update claude --secret' }, 'partial', 'warn  something\n\u001b[31mfail\u001b[0m  Claude Code update failed\u0007\n\n');
  let state = await f.updates();
  assert.equal(state.pending, null);
  assert.deepEqual(state.error, { message: 'fail  Claude Code update failed', at: '1970-01-01T00:02:00.000Z' });
  assert.equal(f.calls.at(-1)!.args[0], 'outdated', 'a failure is followed by a check as well');
  f.answer(2, null, outdated(item('claude')));
  await f.update('pc', ['claude']);
  assert.equal((await f.updates()).error, null);
  f.answer(3, { code: 7 });
  assert.equal((await f.updates()).error.message, 'Update failed (exit code 7)');
  f.answer(4, null, outdated(item('claude')));
  await f.update('pc', ['claude']); f.answer(5, { code: 1 }, 'out only line', '');
  assert.equal((await f.updates()).error.message, 'out only line');
  f.answer(6, null, outdated(item('claude')));
  await f.update('pc', ['claude']); f.answer(7, { code: 1 }, '', 'x'.repeat(400));
  assert.equal((await f.updates()).error.message.length, 160);
});

test('a check that cannot even start leaves the Machine unchecked, without the command line', async t => {
  const f = await fixture(t, { throws: true }); await f.online('pc');
  assert.equal((await f.check('pc')).status, 202);
  const state = await f.updates();
  assert.equal(state.checking, false);
  assert.equal(state.checkedAt, null);
  assert.doesNotMatch(JSON.stringify(state), /secret/);
});

test('an update that throws on start reports a generic failure', async t => {
  let thrown = false;
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  const original = f.calls.push.bind(f.calls);
  f.calls.push = (...args: any[]) => { if (args[0].args[0] === 'update' && !thrown) { thrown = true; throw new Error('Command failed: /secret/hangar update claude'); } return original(...args); };
  assert.equal((await f.update('pc', ['claude'])).status, 202);
  const state = await f.updates();
  assert.equal(state.pending, null);
  assert.equal(state.error.message, 'Update failed (exit code 1)');
  assert.doesNotMatch(JSON.stringify(state), /secret/);
});

test('an update running 15 minutes ends with an error and a fresh check; the late callback is ignored', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  await f.update('pc', ['claude']);
  await f.advance(15 * 60_000 - 1, 'pc');
  assert.notEqual((await f.updates()).pending, null);
  await f.advance(1, 'pc');
  const state = await f.updates();
  assert.equal(state.pending, null);
  assert.equal(state.error.message, 'Timed out after 15 minutes');
  assert.deepEqual(f.calls.at(-1)!.args, ['outdated', '--json']);
  f.answer(1, { killed: true, code: null });
  assert.equal((await f.updates()).error.message, 'Timed out after 15 minutes', 'the late exit changes nothing the page sees');
});

test('after the 15-minute limit the updater is stopped with its whole group, and no second update starts until it has exited', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  await f.update('pc', ['claude']);
  const pid = 4000 + 2;
  await f.advance(15 * 60_000, 'pc');
  assert.equal((await f.updates()).pending, null);
  assert.equal((await f.updates()).error.message, 'Timed out after 15 minutes');
  assert.deepEqual(f.kills, [[-pid, 'SIGTERM'], [pid, 'SIGTERM']]);
  assert.equal((await f.update('pc', ['claude'])).status, 409, 'still running');
  await f.advance(9_000, 'pc'); assert.equal(f.kills.length, 2, 'a grace period before KILL');
  await f.advance(1_000, 'pc');
  assert.deepEqual(f.kills.slice(2), [[-pid, 'SIGKILL'], [pid, 'SIGKILL']]);
  await f.advance(60_000, 'pc'); assert.equal(f.kills.length, 4, 'KILL is sent once');
  assert.equal((await f.update('pc', ['claude'])).status, 409, 'until the process has actually exited');
  f.answer(1, { killed: true, signal: 'SIGKILL' });
  const before = f.calls.length;
  assert.equal(f.calls.at(-1)!.args[0], 'outdated');
  assert.equal((await f.update('pc', ['claude'])).status, 202);
  assert.equal(f.calls.length, before + 1);
});

test('a real updater that ignores SIGTERM and has descendants is gone after the limit and the grace period', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-kill-')); t.after(() => rmSync(dir, { recursive: true }));
  const script = join(dir, 'hangar'), pidfile = join(dir, 'sleep.pid');
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = outdated ]; then echo '${outdated(item('claude'))}'; exit 0; fi\ntrap '' TERM\nsleep 60 &\necho $! > ${pidfile}\nwait\n`);
  chmodSync(script, 0o755);
  const f = await fixture(t, { real: true, hangar: script }); await f.online('pc');
  const until = async (ok: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200 && !(await ok()); i++) await new Promise(r => setTimeout(r, 25)); assert.equal(await ok(), true); };
  f.app.tick(); await f.check('pc'); await until(async () => (await f.updates()).items.length === 1);
  assert.equal((await f.update('pc', ['claude'])).status, 202);
  await until(() => { try { return Number(readFileSync(pidfile, 'utf8')) > 0; } catch { return false; } });
  const sleeper = Number(readFileSync(pidfile, 'utf8')), alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { try { process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL'); } catch {} });   // whichever updater started last
  await f.advance(15 * 60_000, 'pc');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(alive(sleeper), true, 'SIGTERM is ignored');
  assert.equal((await f.update('pc', ['claude'])).status, 409);
  await f.advance(10_000, 'pc');
  await until(() => !alive(sleeper));   // the real process group received SIGKILL, descendants included
  let status = 409;
  for (let i = 0; i < 200 && status !== 202; i++) { status = (await f.update('pc', ['claude'])).status; if (status !== 202) await new Promise(r => setTimeout(r, 25)); }
  assert.equal(status, 202, 'a new update starts once the old one has exited');
});

test('exec reporting a kill by timeout is also an error', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  await f.update('pc', ['claude']);
  f.answer(1, { killed: true, signal: 'SIGTERM' }, 'noise');
  assert.equal((await f.updates()).error.message, 'Timed out after 15 minutes');
});

test('a check that was already running when an update ends is repeated', async t => {
  const f = await fixture(t); await f.online('pc');
  await f.seed('pc', item('claude'));
  await f.update('pc', ['claude']);
  await f.check('pc'); // runs beside the update
  f.answer(1, null, 'done');
  assert.equal(f.calls.filter(c => c.args[0] === 'outdated').length, 2);
  f.answer(2, null, outdated(item('claude')));
  assert.equal(f.calls.filter(c => c.args[0] === 'outdated').length, 3, 'rechecked after the stale check finished');
  assert.equal((await f.updates()).checking, true);
});

test('checks start a minute after the server, repeat every 6 hours, skip Offline Machines and retry failures later', async t => {
  const f = await fixture(t, { checks: true });
  await f.advance(59_000, 'pc', 'mac'); assert.equal(f.calls.length, 0);
  await f.advance(1_000, 'pc', 'mac');
  assert.deepEqual(f.calls.map(c => c.file), ['/repo/bin/hangar', 'ssh']);
  f.answer(0, null, outdated(item('claude')));
  f.answer(1, { code: 255 }, '', 'Permission denied (publickey).');
  await f.advance(9 * 60_000, 'pc', 'mac'); assert.equal(f.calls.length, 2, 'the Mac failed: wait 10 minutes');
  await f.advance(60_000, 'pc', 'mac'); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].file, 'ssh');
  f.answer(2, null, outdated(item('gh')));
  await f.advance(5 * 3_600_000, 'pc', 'mac'); assert.equal(f.calls.length, 3);
  // Both Machines go quiet when the 6 hours pass: Offline ones are skipped, and checked as soon as they are back.
  await f.advance(3_600_000); assert.equal(f.calls.length, 3);
  await f.advance(1000, 'pc');
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].file, '/repo/bin/hangar');
  assert.equal((await f.updates('mac')).items[0].id, 'gh', 'the Mac keeps its last result while Offline');
  f.answer(3, null, outdated(item('claude')));
  await f.advance(1000, 'pc', 'mac');
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[4].file, 'ssh');
});

function t3Database(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-t3-')); t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, completed_at TEXT);`);
  const thread = (id: string, title: string, extra: { archived?: string; deleted?: string } = {}) => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?)').run(id, 'p', title, extra.archived ?? null, extra.deleted ?? null);
  const run = (id: string, thread: string, ordinal: number, status: string, completed: string | null) => db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?)').run(id, thread, ordinal, status, completed);
  return { path, db, thread, run };
}

test('t3-threads lists live threads with an unfinished run, read-only', async t => {
  const d = t3Database(t);
  d.thread('a', 'Build the page'); d.run('a1', 'a', 1, 'completed', 'x'); d.run('a2', 'a', 2, 'running', null);
  d.thread('b', 'Waiting\u0007 on you'); d.run('b1', 'b', 1, 'waiting', null); d.run('b2', 'b', 2, 'queued', null);
  d.thread('c', 'Finished'); d.run('c1', 'c', 1, 'completed', 'x');
  d.thread('d', 'Archived', { archived: 'x' }); d.run('d1', 'd', 1, 'running', null);
  d.thread('e', 'Deleted', { deleted: 'x' }); d.run('e1', 'e', 1, 'running', null);
  d.thread('f', 'No runs');
  d.thread('g', ''); d.run('g1', 'g', 1, 'running', null);
  const f = await fixture(t, { t3Db: d.path }); await f.online('pc');
  assert.equal((await fetch(f.base + '/api/machines/pc/t3-threads')).status, 404, 'no t3 item known yet');
  await f.seed('pc', item('t3'), item('claude'));
  const response = await fetch(f.base + '/api/machines/pc/t3-threads');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /json/);
  const { threads } = await response.json();
  assert.deepEqual(threads.sort((x: any, y: any) => x.title.localeCompare(y.title)), [
    { title: 'Build the page', status: 'running' }, { title: 'Untitled', status: 'running' }, { title: 'Waiting on you', status: 'queued' },
  ]);
  assert.equal((d.db.prepare('SELECT count(*) AS n FROM orchestration_v2_projection_runs').get() as any).n, 8, 'untouched');
});

test('t3-threads is null when the database is missing or its schema changed, and 404 without t3 or off the PC', async t => {
  const d = t3Database(t);
  d.db.exec('ALTER TABLE orchestration_v2_projection_runs RENAME COLUMN completed_at TO finished_at');
  const f = await fixture(t, { t3Db: d.path }); await f.online('pc', 'mac');
  await f.seed('pc', item('t3'));
  assert.deepEqual(await (await fetch(f.base + '/api/machines/pc/t3-threads')).json(), { threads: null });
  const missing = await fixture(t, { t3Db: join(tmpdir(), 'hangar-missing', 'nothing.sqlite') }); await missing.online('pc'); await missing.seed('pc', item('t3'));
  assert.deepEqual(await (await fetch(missing.base + '/api/machines/pc/t3-threads')).json(), { threads: null });
  assert.equal(readT3Threads(d.path), null);
  await f.seed('mac', item('t3'));
  assert.equal((await fetch(f.base + '/api/machines/mac/t3-threads')).status, 404, 'T3 is read from the PC only');
  assert.equal((await fetch(f.base + '/api/machines/nobody/t3-threads')).status, 404);
  const g = await fixture(t); await g.online('pc'); await g.seed('pc', item('claude'));
  assert.equal((await fetch(g.base + '/api/machines/pc/t3-threads')).status, 404);
});

test('GET /api/machines names the page being served, and the name changes when the page is rebuilt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-dist-')); t.after(() => rmSync(dir, { recursive: true }));
  const app = createDashboard({ db: ':memory:', machines, collect: false, dist: dir, hosts: [] });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const build = async () => (await (await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/machines`)).json()).build;
  assert.equal(await build(), '', 'no page built yet');
  writeFileSync(join(dir, 'index.html'), '<script src="/assets/a.js"></script>');
  const first = await build();
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(await build(), first);
  writeFileSync(join(dir, 'index.html'), '<script src="/assets/b.js"></script>');
  const second = await build();
  assert.match(second, /^[0-9a-f]{12}$/);
  assert.notEqual(second, first);
});
