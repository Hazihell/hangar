import type { Machine } from './store.ts';
import type { Exec } from './vpn.ts';
import { lastLine } from './updates.ts';
import type { RemoteControl, RemoteControlFolder as Folder } from '../contract.ts';
export type { RemoteControl as RemoteControlState, RemoteControlFolder as Folder } from '../contract.ts';

export const RC_TIMEOUT = 60_000;
const LIST_TIMEOUT = 20_000;
const GRACE = 10_000, FIRST_LIST = 5_000, EVERY = 30_000, MAX_FOLDERS = 200, MAX_CANDIDATES = 500;
const MODES = ['worktree', 'same-dir'], STATES = ['running', 'starting', 'failing', 'stopped'];
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && /^\/[^\x00-\x1f\x7f-\x9f]*$/.test(value);

/** Reads `hangar rc list --json`, keeping only entries that fit the contract. Null if the output isn't that document at all. */
export function parseList(stdout: unknown): { folders: Folder[]; candidates: string[] } | null {
  let value: any;
  try { value = JSON.parse(String(stdout ?? '').trim()); } catch { return null; }
  if (!value || typeof value !== 'object' || !Array.isArray(value.folders) || !Array.isArray(value.candidates)) return null;
  const seen = new Set<string>(), folders: Folder[] = [];
  for (const raw of value.folders) {
    if (!raw || typeof raw !== 'object' || !absolute(raw.path) || seen.has(raw.path) || !MODES.includes(raw.mode) || !STATES.includes(raw.state)) continue;
    seen.add(raw.path);
    folders.push({ path: raw.path, mode: raw.mode, state: raw.state });
  }
  const candidates = [...new Set<string>(value.candidates.filter(absolute))];
  return { folders: folders.slice(0, MAX_FOLDERS), candidates: candidates.slice(0, MAX_CANDIDATES) };
}

/** What failed, from the command's output: its last line, without the `fail` mark `hangar` prints before it. */
export function failureLine(stdout: unknown, stderr: unknown) {
  return (lastLine(stdout) || lastLine(stderr)).replace(/^fail\s+/, '').trim();
}

/** `running` outlives `state.pending`: after a timeout the command may still be alive, and a second one must wait until it is gone. */
type Entry = { state: RemoteControl; due: number; listing: boolean; recheck: boolean; run?: object; running: boolean; pid: number | null; since: number; stopped?: { at: number; killed: boolean }; logged?: string };

/**
 * For the Machine the server runs on, which folders Claude's Remote Control serves (`hangar rc list`), and the add or remove the page asked for.
 * `hangar` does the work; this only runs it, keeps the answer in memory and tells the page. The path of an add or remove must be one the
 * latest list offered, so the page can never make the server serve an arbitrary folder.
 */
export function createRemoteControl(options: { machines: Machine[]; exec: Exec; clock: () => number; hangar: string; online: (machine: Machine) => boolean; emit: (machine: Machine, now: number) => void; schedule?: boolean; kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void }) {
  const { machines, exec, clock, emit } = options;
  const entries = new Map<string, Entry>();
  const has = (machine: Machine) => machine.collector === 'wsl';
  for (const machine of machines) if (has(machine)) entries.set(machine.id, { state: { folders: [], candidates: [], checkedAt: null, pending: null, error: null }, due: clock() + FIRST_LIST, listing: false, recheck: false, running: false, pid: null, since: 0 });
  const entry = (machine: Machine) => entries.get(machine.id)!;
  let closed = false;
  // The command leads its own process group (detached), so one signal reaches everything it started.
  const kill = options.kill ?? ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => process.kill(pid, signal));
  function signal(e: Entry, name: 'SIGTERM' | 'SIGKILL') {
    if (e.pid === null) return;
    for (const target of [-e.pid, e.pid]) try { kill(target, name); } catch {}
  }
  const copy = (s: RemoteControl): RemoteControl => ({ ...s, folders: s.folders.map(f => ({ ...f })), candidates: [...s.candidates], pending: s.pending && { ...s.pending }, error: s.error });

  function list(machine: Machine) {
    const e = entry(machine);
    if (e.listing) { e.recheck = true; return; }
    e.listing = true;
    const done = (error: any, stdout: string, stderr: string) => {
      if (closed) return;
      e.listing = false;
      const found = error ? null : parseList(stdout);
      const now = clock();
      e.due = now + EVERY;
      let changed = false;
      if (found) {
        const before = JSON.stringify([e.state.folders, e.state.candidates]);
        e.state.folders = found.folders; e.state.candidates = found.candidates;
        changed = e.state.checkedAt === null || JSON.stringify([found.folders, found.candidates]) !== before;
        e.state.checkedAt = now;
        e.logged = undefined;
      } else {
        // Keep the last answer; say why once, not every 30 seconds.
        const why = error ? (error.killed ? 'timed out' : lastLine(stderr, 120) || `exit code ${error.code ?? 1}`) : "hangar rc list didn't answer with JSON";
        if (e.logged !== why) console.error(`Remote Control: listing ${machine.id} failed: ${why}`);
        e.logged = why;
      }
      if (changed) emit(machine, now);
      if (e.recheck) { e.recheck = false; list(machine); }
    };
    try { exec(options.hangar, ['rc', 'list', '--json'], { timeout: LIST_TIMEOUT, encoding: 'utf8', maxBuffer: 1024 * 1024 }, done); } catch (error) { done(error, '', ''); }
  }

  function finish(machine: Machine, e: Entry, error: string | null) {
    e.run = undefined; e.state.pending = null;
    if (error) e.state.error = error;
    emit(machine, clock());
    list(machine);
  }

  /** The HTTP status for a request to `action` on `path` (the Machine itself already known to have Remote Control). */
  function start(machine: Machine, action: unknown, path: unknown): 202 | 400 | 409 {
    const e = entry(machine);
    if (action !== 'add' && action !== 'remove') return 400;
    // The security boundary: only a path `hangar rc list` itself offered.
    if (typeof path !== 'string' || !(action === 'add' ? e.state.candidates.includes(path) : e.state.folders.some(f => f.path === path))) return 400;
    if (!options.online(machine) || e.state.pending || e.running) return 409;
    const now = clock(), run = {};
    e.run = run; e.running = true; e.pid = null; e.stopped = undefined; e.since = now;
    e.state.pending = { action, path };
    e.state.error = null;
    emit(machine, now);
    const done = (error: any, stdout: string, stderr: string) => {
      if (closed) return;
      e.running = false; e.pid = null; e.stopped = undefined;   // the process is gone
      if (e.run !== run) { list(machine); return; }   // it had timed out; it may have got somewhere before it died
      finish(machine, e, error ? error.killed ? `Timed out after ${RC_TIMEOUT / 1000} seconds` : failureLine(stdout, stderr) || `${action === 'add' ? 'Adding' : 'Removing'} the folder failed (exit code ${Number.isInteger(error.code) ? error.code : 1})` : null);
    };
    // The time limit is ours (see tick): execFile's would only stop the direct child.
    try {
      const child: any = exec(options.hangar, ['rc', action, path], { timeout: 0, encoding: 'utf8', maxBuffer: 1024 * 1024, detached: true }, done);
      if (e.running && e.run === run && Number.isInteger(child?.pid) && child.pid > 1) e.pid = child.pid;
    } catch (error) { done(error, '', ''); }
    return 202;
  }

  function tick(now: number) {
    for (const machine of machines) {
      if (!has(machine)) continue;
      const e = entry(machine);
      const pending = e.state.pending;
      if (e.running && e.stopped && !e.stopped.killed && now - e.stopped.at >= GRACE) { e.stopped.killed = true; signal(e, 'SIGKILL'); }
      if (pending && now - e.since >= RC_TIMEOUT) {
        e.stopped = { at: now, killed: false }; signal(e, 'SIGTERM');
        finish(machine, e, `Timed out after ${RC_TIMEOUT / 1000} seconds`); continue;
      }
      if (options.schedule !== false && now >= e.due && !pending && !e.running && !e.listing && options.online(machine)) list(machine);
    }
  }

  return { has, state: (machine: Machine) => copy(entry(machine).state), start, tick, close() { closed = true; entries.clear(); } };
}
