import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Machine } from './store.ts';
import type { Exec } from './vpn.ts';

export const UPDATE_IDS = ['t3', 'claude', 'codex', 'gh', 'tea', 'hangar'] as const;
import type { Update, Updates as UpdatesState, T3Thread as Thread } from '../contract.ts';
export type { Update, Updates as UpdatesState, T3Thread as Thread } from '../contract.ts';
/**
 * execFile that can start the command as the leader of its own process group (`detached`), which execFile itself can't:
 * the group is how a timed-out updater and everything it started get stopped together. Output beyond `maxBuffer` drops
 * from the front, so the last line is always there. Reports back when the command itself has exited.
 */
export const detachedExec: Exec = (file, args, options, done) => {
  const child = spawn(file, args, { detached: options.detached === true, stdio: ['ignore', 'pipe', 'pipe'] });
  const max = options.maxBuffer ?? 1024 * 1024;
  let out = '', err = '', finished = false, timedOut = false, drain: ReturnType<typeof setTimeout> | undefined;
  const limit = options.timeout > 0 ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeout) : undefined;
  const finish = (error: any) => {
    if (finished) return;
    finished = true; clearTimeout(limit); clearTimeout(drain);
    done(error, out, err);
  };
  const collect = (add: (text: string) => void) => (chunk: string) => add(chunk);
  child.stdout.setEncoding('utf8').on('data', collect(text => { out = (out + text).slice(-max); }));
  child.stderr.setEncoding('utf8').on('data', collect(text => { err = (err + text).slice(-max); }));
  child.on('error', finish);
  // A descendant that outlives the command can hold its pipes open; don't wait on them for more than a moment.
  child.on('exit', () => { drain = setTimeout(() => finish(failure(child.exitCode, child.signalCode, timedOut)), 1000); });
  child.on('close', (code, signal) => finish(failure(code, signal, timedOut)));
  return child;
};
function failure(code: number | null, signal: NodeJS.Signals | null, killed: boolean) {
  return code === 0 ? null : Object.assign(new Error('Command failed'), { code, signal, killed });
}


const CHECK_TIMEOUT = 90_000;
export const UPDATE_TIMEOUT = 15 * 60_000;
const GRACE = 10_000, FIRST_CHECK = 60_000, EVERY = 6 * 3_600_000, RETRY = 10 * 60_000;
const version = /^[0-9A-Za-z][0-9A-Za-z.+~_-]{0,63}$/;
const plain = (value: string, max: number) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, max);

/** The last non-empty line, free of terminal codes and control characters, short enough to show. */
export function lastLine(text: unknown, max = 160) {
  const lines = String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r\n|\r|\n/).map(l => plain(l, max)).filter(Boolean);
  return lines.at(-1) ?? '';
}

/** Reads `hangar outdated --json`, keeping only items that fit the contract. Null if the output isn't that document at all. */
export function parseOutdated(stdout: unknown): Update[] | null {
  const text = String(stdout ?? '').trim();
  let value: any;
  try { value = JSON.parse(text); } catch {
    try { value = JSON.parse(text.split(/\r?\n/).filter(l => l.trim()).at(-1) ?? ''); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null;
  const found = new Map<string, Update>();
  for (const raw of value.items) {
    if (!raw || typeof raw !== 'object' || !UPDATE_IDS.includes(raw.id) || found.has(raw.id)) continue;
    const text = (v: unknown) => v === null ? null : typeof v === 'string' && version.test(v) ? v : undefined;
    const current = text(raw.current), latest = text(raw.latest);
    if (typeof raw.name !== 'string' || !plain(raw.name, 40) || current === undefined || latest === undefined || typeof raw.available !== 'boolean') continue;
    if (raw.blocked !== null && (typeof raw.blocked !== 'string' || !plain(raw.blocked, 160))) continue;
    const item: Update = { id: raw.id, name: plain(raw.name, 40), current, latest, available: raw.available && current !== null && latest !== null, blocked: raw.blocked === null ? null : plain(raw.blocked, 160) };
    if (raw.id === 'hangar') {
      if (raw.behind !== undefined && raw.behind !== null && !(Number.isSafeInteger(raw.behind) && raw.behind >= 0)) continue;
      item.behind = raw.behind ?? null;
    }
    found.set(raw.id, item);
  }
  return UPDATE_IDS.flatMap(id => found.get(id) ?? []);
}

/** T3 threads with a run that hasn't finished, read straight from T3's own database; null if that can't be done. */
export function readT3Threads(path: string): Thread[] | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
    const rows = db.prepare(`SELECT t.thread_id AS id, t.title AS title, r.status AS status
      FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND r.completed_at IS NULL
      ORDER BY r.ordinal DESC LIMIT 200`).all() as { id: unknown; title: unknown; status: unknown }[];
    const seen = new Set<unknown>(), threads: Thread[] = [];
    for (const row of rows) {
      if (typeof row.title !== 'string' || typeof row.status !== 'string') return null;
      if (seen.has(row.id)) continue; // a thread's newest open run speaks for it
      seen.add(row.id);
      threads.push({ title: plain(row.title, 120) || 'Untitled', status: plain(row.status, 40) });
    }
    return threads.slice(0, 50);
  } catch { return null; } finally { try { db?.close(); } catch {} }
}

/** `running` outlives `state.pending`: after a timeout the updater may still be alive, and a second one must wait until it is gone. */
type Entry = { state: UpdatesState; due: number; recheck: boolean; checkRun?: object; updateRun?: object; running: boolean; pid: number | null; stopped?: { at: number; killed: boolean } };

/**
 * Per Machine, what `hangar outdated` says is out of date, and the `hangar update` the page asked for.
 * The Machine does the work (the PC here, the Mac over SSH); this only runs it, keeps the answer in memory and tells the page.
 */
export function createUpdates(options: { machines: Machine[]; exec: Exec; clock: () => number; hangar: string; t3Db: string; online: (machine: Machine) => boolean; emit: (machine: Machine, now: number) => void; schedule?: boolean; kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void }) {
  const { machines, exec, clock, emit } = options;
  const entries = new Map<string, Entry>();
  for (const machine of machines) entries.set(machine.id, { state: { checkedAt: null, checking: false, items: [], pending: null, error: null }, due: clock() + FIRST_CHECK, recheck: false, running: false, pid: null });
  const entry = (machine: Machine) => entries.get(machine.id)!;
  let closed = false;
  // The updater leads its own process group (detached), so one signal reaches everything it started.
  const kill = options.kill ?? ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => process.kill(pid, signal));
  function signal(e: Entry, name: 'SIGTERM' | 'SIGKILL') {
    if (e.pid === null) return;
    for (const target of [-e.pid, e.pid]) try { kill(target, name); } catch {}
  }
  // hangar puts ~/.local/bin and Homebrew on PATH itself, so no login shell is needed on the Mac either.
  const command = (machine: Machine, args: string[]) => machine.collector === 'wsl'
    ? { file: options.hangar, args }
    : machine.ssh ? { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', machine.ssh, `"$HOME/.local/bin/hangar" ${args.join(' ')}`] } : null;
  const reachable = (machine: Machine) => command(machine, []) !== null;
  const copy = (s: UpdatesState): UpdatesState => ({ ...s, items: s.items.map(i => ({ ...i })), pending: s.pending && { ...s.pending, items: [...s.pending.items] }, error: s.error && { ...s.error } });

  function check(machine: Machine): 202 | 409 {
    const e = entry(machine), cmd = command(machine, ['outdated', '--json']);
    if (!cmd || e.state.checking || !options.online(machine)) return 409;
    const run = {};
    e.checkRun = run; e.state.checking = true;
    emit(machine, clock());
    const done = (error: any, stdout: string, stderr: string) => {
      if (closed || e.checkRun !== run) return;
      e.checkRun = undefined; e.state.checking = false;
      const items = error ? null : parseOutdated(stdout);
      const now = clock();
      if (items) { e.state.items = items; e.state.checkedAt = new Date(now).toISOString(); e.due = now + EVERY; }
      else {
        e.due = now + RETRY; // keep the last answer; the page sees an old checkedAt
        console.error(`Updates: checking ${machine.id} failed: ${error ? (error.killed ? 'timed out' : lastLine(stderr, 120) || `exit code ${error.code ?? 1}`) : "hangar outdated didn't answer with JSON"}`);
      }
      emit(machine, now);
      if (e.recheck) { e.recheck = false; check(machine); }
    };
    try { exec(cmd.file, cmd.args, { timeout: CHECK_TIMEOUT, encoding: 'utf8', maxBuffer: 1024 * 1024 }, done); } catch (error) { done(error, '', ''); }
    return 202;
  }

  /** After an update ends: look again, even if a check was already under way (it may have run before the update finished). */
  function recheck(machine: Machine) {
    const e = entry(machine);
    if (e.state.checking) e.recheck = true; else check(machine);
  }

  function finish(machine: Machine, e: Entry, error: { message: string } | null) {
    const now = clock();
    e.updateRun = undefined; e.state.pending = null;
    if (error) e.state.error = { message: error.message, at: new Date(now).toISOString() };
    emit(machine, now);
    recheck(machine);
  }

  /** The HTTP status for a request to update `ids` on `machine` (the Machine itself already known to exist). */
  function update(machine: Machine, ids: unknown): 202 | 400 | 409 {
    const e = entry(machine), cmd = command(machine, ['update']);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > UPDATE_IDS.length) return 400;
    const listed = new Map(e.state.items.map(i => [i.id, i]));
    if (ids.some(id => typeof id !== 'string' || !listed.has(id)) || new Set(ids).size !== ids.length) return 400;
    if (!cmd || !options.online(machine) || e.state.pending || e.running || ids.some(id => listed.get(id)!.blocked)) return 409;
    const now = clock(), run = {};
    e.updateRun = run; e.running = true; e.pid = null; e.stopped = undefined;
    e.state.pending = { items: [...ids], since: new Date(now).toISOString() };
    e.state.error = null;
    emit(machine, now);
    const args = ['update', ...ids as string[]];
    const full = command(machine, args)!;
    const done = (error: any, stdout: string, stderr: string) => {
      if (closed) return;
      e.running = false; e.pid = null; e.stopped = undefined;   // the process is gone
      if (e.updateRun !== run) { recheck(machine); return; }   // it had timed out; it may have got somewhere before it died
      finish(machine, e, error ? { message: error.killed ? `Timed out after ${UPDATE_TIMEOUT / 60_000} minutes` : lastLine(stderr) || lastLine(stdout) || `Update failed (exit code ${Number.isInteger(error.code) ? error.code : 1})` } : null);
    };
    // The time limit is ours (see tick): execFile's would only stop the direct child.
    try {
      const child: any = exec(full.file, full.args, { timeout: 0, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, detached: true }, done);
      if (e.running && e.updateRun === run && Number.isInteger(child?.pid) && child.pid > 1) e.pid = child.pid;
    } catch (error) { done(error, '', ''); }
    return 202;
  }

  function tick(now: number) {
    for (const machine of machines) {
      const e = entry(machine);
      const pending = e.state.pending;
      if (e.running && e.stopped && !e.stopped.killed && now - e.stopped.at >= GRACE) { e.stopped.killed = true; signal(e, 'SIGKILL'); }
      if (pending && now - Date.parse(pending.since) >= UPDATE_TIMEOUT) {
        e.stopped = { at: now, killed: false }; signal(e, 'SIGTERM');
        finish(machine, e, { message: `Timed out after ${UPDATE_TIMEOUT / 60_000} minutes` }); continue;
      }
      if (options.schedule !== false && now >= e.due && !pending && reachable(machine) && options.online(machine)) check(machine);
    }
  }

  function threads(machine: Machine): { threads: Thread[] | null } | null {
    if (machine.collector !== 'wsl' || !entry(machine).state.items.some(i => i.id === 't3')) return null;
    return { threads: readT3Threads(options.t3Db) };
  }

  return { state: (machine: Machine) => copy(entry(machine).state), check, update, tick, threads, close() { closed = true; entries.clear(); } };
}
