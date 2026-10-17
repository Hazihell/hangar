// The Alert rule evaluator. Pure: give it the Machines and the time, get back the notifications to push.
import { readFileSync } from 'node:fs';

export type Threshold = { at: number; clear: number };
export type Rules = {
  disk: Threshold;
  cpu: Threshold & { for: number };
  ram: Threshold & { for: number };
  offline: { for: number; machines: string[] };
  vpn: boolean;
  t3: boolean;
  /** Seconds before an Alert may fire again. */
  cooldown: number;
};

export const DEFAULT_RULES: Rules = {
  disk: { at: 90, clear: 85 },
  cpu: { at: 90, clear: 80, for: 300 },
  ram: { at: 90, clear: 85, for: 300 },
  offline: { for: 120, machines: ['stormtrooper'] },
  vpn: true,
  t3: true,
  cooldown: 1800,
};

type AppView = { name: string; cpu: number; ram: number; apps?: AppView[] };
/** The parts of a Machine in `GET /api/machines` that the rules read. */
export type MachineView = {
  id: string;
  name: string;
  online: boolean;
  lastSeen?: string | null;
  usage?: {
    at?: string;
    cpu: number;
    ram: { used: number; total: number };
    disks: { name: string; used: number; total: number }[];
    services?: Record<string, boolean>;
  } | null;
  vpns?: { name: string; status: string; pending?: { action: string } | null }[];
  apps?: { list: AppView[] } | null;
};

/** `gen` numbers an Alert's notifications, one more for every fire and every clear; it is for acknowledgements and is not part of the pushed payload. */
export type Notification = { title: string; body: string; tag: string; machine: string; quiet: boolean; gen: number };

type Text = { title: string; body: string };
type Msg = Text & { machine: string };
/** A notification waiting for a subscription to accept it. */
type Outbox = { kind: 'fire' | 'clear'; gen: number; first: number; last: number; n: Msg };
/** The newest notification of an Alert, sent or not: what a device should end up showing. */
type Latest = Msg & { kind: 'fire' | 'clear'; gen: number; at: number };
/**
 * Per Alert (by tag):
 * - `active`: its condition holds (or held and hasn't cleared); cooldown-muted occurrences are active too.
 * - `delivered`: a device has accepted its fire notification and no clear has replaced it yet.
 * - `outbox`: the fire or clear notification not yet accepted by any subscription.
 * - `gen`, `latest`: the generation counter and the newest notification, so a late acknowledgement of an older one can be answered with it, and a new device can be told of an Alert that is firing.
 * - `since`/`sampleAt`: start and latest sample of the CPU/RAM streak, or when an Offline Machine's clock started.
 */
type Entry = { active: boolean; delivered: boolean; outbox: Outbox | null; gen: number; latest: Latest | null; lastFired: number | null; since: number | null; sampleAt: number | null };
/** `vpns` remembers the VPNs last seen `connected` (and not being disconnected on purpose), by tag. */
export type AlertsState = { entries: Record<string, Entry>; vpns: Record<string, 'connected'> };

/** Context only the server knows. */
export type Context = {
  /** VPNs (machine id, VPN name) whose Dashboard `disconnect` just completed: the report showing `disconnected` already cleared `pending`. */
  completedDisconnects?: { machine: string; vpn: string }[];
  /** When the Dashboard started watching: it can't know a Machine was Offline before that. */
  observedFrom?: number;
};

export const RETRY_EVERY = 60_000;
export const RETRY_FOR = 10 * 60_000;
/** Samples further apart than this don't make one CPU/RAM streak (a restart, sleep or Offline in between). */
export const MAX_GAP = 60_000;
/** A Machine is Offline this long after its last report. */
const ONLINE_FOR = 30_000;

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function validThreshold(v: unknown, sustained: boolean): boolean {
  return object(v) && num(v.at, 1, 100) && num(v.clear, 0, 100) && v.clear < v.at && (!sustained || num(v.for, 0, 86_400));
}

/** Throws a message naming the first thing wrong with `rules`. */
export function validateRules(rules: unknown): asserts rules is Rules {
  if (!object(rules)) throw new Error('not an object');
  if (!validThreshold(rules.disk, false)) throw new Error('disk needs at (1-100) and clear (below at)');
  if (!validThreshold(rules.cpu, true)) throw new Error('cpu needs at, clear (below at) and for (seconds)');
  if (!validThreshold(rules.ram, true)) throw new Error('ram needs at, clear (below at) and for (seconds)');
  if (!object(rules.offline) || !num(rules.offline.for, 0, 604_800) || !Array.isArray(rules.offline.machines) || !rules.offline.machines.every((m: unknown) => typeof m === 'string')) {
    throw new Error('offline needs for (seconds) and machines (ids)');
  }
  if (typeof rules.vpn !== 'boolean' || typeof rules.t3 !== 'boolean') throw new Error('vpn and t3 must be true or false');
  if (!num(rules.cooldown, 0, 604_800)) throw new Error('cooldown must be a number of seconds');
}

/** Reads and checks the rules at `path`; on any error warns and returns the defaults. */
export function loadRules(path: string, warn: (message: string) => void = message => console.warn(message)): Rules {
  try {
    const rules = JSON.parse(readFileSync(path, 'utf8'));
    validateRules(rules);
    return structuredClone(rules);
  } catch (error: any) {
    warn(`alerts: ${path}: ${error?.message ?? error}; using the default rules`);
    return structuredClone(DEFAULT_RULES);
  }
}

const NNBSP = ' ';
const MiB = 1024 ** 2, GiB = 1024 ** 3, TiB = 1024 ** 4;

// Same as the page's formatPercent and formatBytes (web/src/lib/format.ts), plus MB for small Apps.
export function formatPercent(value: number): string {
  if (value > 0 && value < 1) return `<1${NNBSP}%`;
  return `${Math.round(value)}${NNBSP}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < GiB) return `${Math.round(bytes / MiB)}${NNBSP}MB`;
  const [value, label] = bytes >= TiB ? [bytes / TiB, 'TB'] : [bytes / GiB, 'GB'];
  const digits = value >= 100 ? 0 : 1;
  return `${value.toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: digits })}${NNBSP}${label}`;
}

function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

/** Up to three Top Apps by `key`, Apps inside WSL ranked with the rest and prefixed `WSL `; the WSL App itself is left out. */
function topApps(machine: MachineView, key: 'cpu' | 'ram', show: (value: number) => string): string {
  const list = machine.apps?.list;
  if (!Array.isArray(list)) return '';
  const all: { name: string; value: number }[] = [];
  for (const app of list) {
    if (app.name === 'WSL') {
      for (const inner of app.apps ?? []) all.push({ name: `WSL ${inner.name}`, value: inner[key] });
    } else all.push({ name: app.name, value: app[key] });
  }
  return all.filter(a => a.value > 0).sort((a, b) => b.value - a.value).slice(0, 3).map(a => `${a.name} ${show(a.value)}`).join(', ');
}

const fresh = (): Entry => ({ active: false, delivered: false, outbox: null, gen: 0, latest: null, lastFired: null, since: null, sampleAt: null });
const text = (v: unknown): (Text & { machine: string }) | null =>
  object(v) && typeof v.title === 'string' && typeof v.body === 'string' && typeof v.machine === 'string' ? { title: v.title, body: v.body, machine: v.machine } : null;
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function restore(state: unknown): AlertsState {
  const out: AlertsState = { entries: {}, vpns: {} };
  if (!object(state)) return out;
  if (object(state.entries)) {
    for (const [tag, e] of Object.entries(state.entries)) {
      if (!object(e)) continue;
      const gen = typeof e.gen === 'number' && Number.isInteger(e.gen) ? e.gen : 1;
      const o = object(e.outbox) && (e.outbox.kind === 'fire' || e.outbox.kind === 'clear') && time(e.outbox.first) !== null && time(e.outbox.last) !== null ? text(e.outbox.n) : null;
      const l = object(e.latest) && (e.latest.kind === 'fire' || e.latest.kind === 'clear') ? text(e.latest) : null;
      out.entries[tag] = {
        active: e.active === true, delivered: e.delivered === true, gen, lastFired: time(e.lastFired), since: time(e.since), sampleAt: time(e.sampleAt),
        outbox: o ? { kind: e.outbox.kind, gen: typeof e.outbox.gen === 'number' ? e.outbox.gen : gen, first: e.outbox.first, last: e.outbox.last, n: o } : null,
        latest: l ? { ...l, kind: e.latest.kind, gen: typeof e.latest.gen === 'number' ? e.latest.gen : gen, at: time(e.latest.at) ?? 0 } : null,
      };
    }
  }
  if (object(state.vpns)) for (const [tag, v] of Object.entries(state.vpns)) if (v === 'connected') out.vpns[tag] = 'connected';
  return out;
}

export function createAlerts(rules: Rules, initial?: unknown) {
  const s = restore(initial);
  const cooldownMs = rules.cooldown * 1000;

  const entry = (tag: string): Entry => (s.entries[tag] ??= fresh());
  const note = (tag: string, n: Msg, quiet: boolean, gen: number): Notification => ({ title: n.title, body: n.body, tag, machine: n.machine, quiet, gen });

  /** A new generation of `tag`'s notifications, remembered as its newest. */
  function advance(e: Entry, kind: 'fire' | 'clear', n: Msg, now: number) {
    e.gen += 1;
    e.latest = { ...n, kind, gen: e.gen, at: now };
  }

  /** The Alert's condition ends: replace the notification a device holds, if one does. */
  function release(tag: string, machine: string, now: number, message: Text, out: Notification[]) {
    const e = entry(tag);
    e.active = false;
    advance(e, 'clear', { ...message, machine }, now);
    // If nobody has accepted the fire, there is nothing to replace; one still in flight is answered when it lands (see current()).
    if (e.delivered) {
      e.outbox = { kind: 'clear', gen: e.gen, first: now, last: now, n: e.latest! };
      out.push(note(tag, e.latest!, true, e.gen));
    } else e.outbox = null;
  }

  /**
   * One step of an Alert's life. It fires when `trigger` holds while it is not active (a firing within
   * the cooldown of the last one is only muted), and clears when `release` holds while active.
   */
  function step(tag: string, machine: string, now: number, trigger: boolean, released: boolean, fire: () => Text, clear: () => Text, out: Notification[]) {
    const e = entry(tag);
    if (!e.active) {
      if (!trigger) return;
      e.active = true;
      if (e.outbox?.kind === 'clear') e.outbox = null; // the new fire replaces it anyway
      if (e.lastFired === null || now - e.lastFired >= cooldownMs) {
        e.lastFired = now;
        advance(e, 'fire', { ...fire(), machine }, now);
        e.outbox = { kind: 'fire', gen: e.gen, first: now, last: now, n: e.latest! };
        out.push(note(tag, e.latest!, false, e.gen));
      }
    } else if (released) release(tag, machine, now, clear(), out);
  }

  /** An Alert about something the Machine no longer lists (a disk, a VPN): it can't clear by itself. */
  function retire(prefix: string, still: Set<string>, machine: string, now: number, gone: (name: string) => Text, out: Notification[]) {
    for (const tag of Object.keys(s.entries)) {
      if (!tag.startsWith(prefix) || still.has(tag)) continue;
      if (s.entries[tag].active) release(tag, machine, now, gone(tag.slice(prefix.length)), out);
    }
  }

  function sustained(kind: 'cpu' | 'ram', m: MachineView, now: number, out: Notification[]) {
    const rule = rules[kind];
    const usage = m.usage!;
    const value = kind === 'cpu' ? usage.cpu : (usage.ram.used / usage.ram.total) * 100;
    const tag = `${m.id}:${kind}`;
    const e = entry(tag);
    if (value >= rule.at) {
      const parsed = Date.parse(usage.at ?? '');
      const at = Number.isFinite(parsed) && parsed <= now ? parsed : now;
      if (e.since === null || e.sampleAt === null || at - e.sampleAt > MAX_GAP) e.since = at;
      e.sampleAt = Math.max(at, e.sampleAt ?? at);
    } else { e.since = null; e.sampleAt = null; }
    const label = kind === 'cpu' ? 'CPU' : 'RAM';
    const trigger = e.since !== null && now - e.since >= rule.for * 1000;
    step(tag, m.id, now, trigger, value < rule.clear,
      () => {
        const apps = topApps(m, kind, kind === 'cpu' ? formatPercent : formatBytes);
        return { title: `${m.name} ${label} high`, body: `${formatPercent(value)} for ${formatSeconds(rule.for)}${apps ? `: ${apps}` : ''}` };
      },
      () => ({ title: `${m.name} ${label} back to normal`, body: `Now ${formatPercent(value)}` }), out);
  }

  function evaluate(machines: MachineView[], now: number, ctx: Context = {}): Notification[] {
    const out: Notification[] = [];
    const completed = new Set((ctx.completedDisconnects ?? []).map(c => `${c.machine}:vpn:${c.vpn}`));
    for (const m of machines) {
      if (rules.offline.machines.includes(m.id)) {
        const tag = `${m.id}:offline`;
        const e = entry(tag);
        const lastSeen = m.lastSeen ? Date.parse(m.lastSeen) : NaN;
        let start: number | null = null;
        if (m.online) e.since = null;
        else if (Number.isFinite(lastSeen)) start = Math.max(lastSeen + ONLINE_FOR, ctx.observedFrom ?? 0);
        else start = e.since = Math.max(e.since ?? now, ctx.observedFrom ?? 0); // never reported: count from when the Dashboard first noticed
        step(tag, m.id, now, start !== null && now - start >= rules.offline.for * 1000, m.online,
          () => ({ title: `${m.name} is Offline`, body: Number.isFinite(lastSeen) ? `Last seen ${formatSeconds((now - lastSeen) / 1000)} ago` : 'It has never reported' }),
          () => ({ title: `${m.name} is back Online`, body: '' }), out);
      }

      const usage = m.usage;
      if (!m.online || !usage) {
        // Stale figures prove nothing, and a gap breaks "every report for N seconds".
        if (!m.online) for (const kind of ['cpu', 'ram']) { const e = s.entries[`${m.id}:${kind}`]; if (e) { e.since = null; e.sampleAt = null; } }
        continue;
      }

      const disks = new Set<string>();
      for (const disk of usage.disks) {
        const pct = (disk.used / disk.total) * 100;
        const tag = `${m.id}:disk:${disk.name}`;
        disks.add(tag);
        step(tag, m.id, now, pct >= rules.disk.at, pct < rules.disk.clear,
          () => ({ title: `${disk.name} on ${m.name} nearly full`, body: `${formatPercent(pct)} full, ${formatBytes(disk.total - disk.used)} free of ${formatBytes(disk.total)}` }),
          () => ({ title: `${disk.name} on ${m.name} is below ${formatPercent(rules.disk.clear)}`, body: `Now ${formatPercent(pct)}` }), out);
      }
      retire(`${m.id}:disk:`, disks, m.id, now, name => ({ title: `${name} on ${m.name} is no longer reported`, body: '' }), out);

      sustained('cpu', m, now, out);
      sustained('ram', m, now, out);

      if (rules.t3 && typeof usage.services?.t3 === 'boolean') {
        const running = usage.services.t3;
        step(`${m.id}:t3`, m.id, now, !running, running,
          () => ({ title: `T3 service stopped on ${m.name}`, body: 'It is not running any more' }),
          () => ({ title: `T3 service running again on ${m.name}`, body: '' }), out);
      }

      if (rules.vpn && Array.isArray(m.vpns)) {
        const names = new Set<string>();
        for (const vpn of m.vpns) {
          const tag = `${m.id}:vpn:${vpn.name}`;
          names.add(tag);
          // Disconnecting from the Dashboard is not a drop; neither is the report that shows it done.
          const intended = vpn.pending?.action === 'disconnect' || completed.has(tag);
          const wasConnected = s.vpns[tag] === 'connected';
          step(tag, m.id, now, wasConnected && vpn.status === 'disconnected' && !intended, vpn.status === 'connected',
            () => ({ title: `${vpn.name} dropped on ${m.name}`, body: 'The VPN disconnected on its own' }),
            () => ({ title: `${vpn.name} reconnected on ${m.name}`, body: '' }), out);
          // "Previously connected" survives connecting and disconnecting; only a plain disconnect or an intended one ends it.
          if (vpn.status === 'connected' && !intended) s.vpns[tag] = 'connected';
          else if (vpn.status === 'disconnected' || intended) delete s.vpns[tag];
        }
        // A VPN that left the list can't have dropped, and its Alert can't clear by itself.
        retire(`${m.id}:vpn:`, names, m.id, now, name => ({ title: `${name} is no longer reported on ${m.name}`, body: '' }), out);
        for (const tag of Object.keys(s.vpns)) if (tag.startsWith(`${m.id}:vpn:`) && !names.has(tag)) delete s.vpns[tag];
      }
    }

    // Notifications no subscription has accepted yet: retry every minute for ten, then give up.
    for (const [tag, e] of Object.entries(s.entries)) {
      const box = e.outbox;
      if (!box) continue;
      if (now - box.first > RETRY_FOR) {
        if (box.kind === 'clear') e.delivered = false; // out of reach; stop insisting
        e.outbox = null;
      } else if (now - box.last >= RETRY_EVERY) {
        box.last = now;
        out.push(note(tag, box.n, box.kind === 'clear', box.gen));
      }
    }

    // Forget Alerts with nothing left to say. A firing is remembered for the cooldown, and no longer.
    for (const [tag, e] of Object.entries(s.entries)) {
      // (a push may still be in flight for a minute, and its acknowledgement needs the generation)
      if (!e.active && !e.delivered && !e.outbox && e.since === null && (e.lastFired === null || now - e.lastFired >= cooldownMs) && (e.latest === null || now - e.latest.at >= 60_000)) delete s.entries[tag];
    }
    return out;
  }

  /**
   * Tells the Alerts that some subscription accepted `n`. It only counts for its own generation:
   * an acknowledgement of a fire or clear that has since been superseded changes nothing.
   */
  function delivered(n: Notification, ok: boolean, now: number) {
    const e = s.entries[n.tag];
    if (!e || !ok || n.gen !== e.gen) return;
    if (e.outbox?.gen === n.gen) e.outbox = null;
    if (n.quiet) e.delivered = false;
    else if (e.active) e.delivered = true; // also a catch-up for a new device
  }

  /**
   * What a subscription that has just accepted `n` should be sent next, if `n` is out of date: the
   * newest notification of that tag. A fire that lands after its Alert cleared would otherwise stay on screen.
   */
  function current(n: Notification): Notification | null {
    const e = s.entries[n.tag];
    if (!e?.latest || n.gen >= e.gen) return null;
    return note(n.tag, e.latest, e.latest.kind === 'clear', e.latest.gen);
  }

  /** The Alerts whose condition holds and that fired, for a device that has just subscribed. */
  function active(): Notification[] {
    return Object.entries(s.entries).filter(([, e]) => e.active && e.latest?.kind === 'fire').map(([tag, e]) => note(tag, e.latest!, false, e.latest!.gen));
  }

  return { evaluate, delivered, current, active, state: (): AlertsState => structuredClone(s) };
}
