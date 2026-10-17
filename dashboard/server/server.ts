import type { Machine as WireMachine, MachineEvent, MachinesResponse, MachineLimits, QuitResponse } from '../contract.ts';
import { PROCESS_LIMIT } from './apps.ts';
import { MAX_TARGETS } from './rules.ts';
import { createPower, POWER_TIMEOUT } from './power.ts';
import { createUpdates, detachedExec, UPDATE_TIMEOUT } from './updates.ts';
import { createQuit } from './quit.ts';
import type { Local } from './quit.ts';
import { execFile } from 'node:child_process';
import { createVpn, VPN_TIMEOUT } from './vpn.ts';
import type { Exec } from './vpn.ts';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, extname, sep, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.ts';
import type { Machine } from './store.ts';
import { Usage } from './usage.ts';
import { validQuit } from './rules.ts';
import { startCollector, collectorPids } from './collector.ts';
import { createAlerts, loadRules, tempLimits, usageLimits } from './alerts.ts';
import type { Rules } from './alerts.ts';
import type { FetchLike } from './push.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
let tailnetName = '', tailnetTried = 0;
function dashboardHosts() {
  // Tailscale may not be up yet at boot; until it answers, ask again at most once a minute, in the background, so the Mac's reports aren't refused for good.
  if (!tailnetName && Date.now() - tailnetTried > 60_000) {
    tailnetTried = Date.now();
    execFile('tailscale', ['status', '--json'], { timeout: 3000, encoding: 'utf8' }, (error, stdout) => {
      if (error) return; // Local access still works without Tailscale.
      try { tailnetName = String(JSON.parse(stdout).Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase(); } catch {}
    });
  }
  return [tailnetName, ...(process.env.HANGAR_DASHBOARD_HOSTS ?? '').split(/[\s,]+/)].filter(Boolean).map(h => h.toLowerCase());
}
export function createDashboard(options: { db: string; t3Db?: string; hangar?: string; updateChecks?: boolean; kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void; machines?: Machine[]; clock?: () => number; collect?: boolean; dist?: string; exec?: Exec; local?: Local; rules?: Rules; vapid?: string; fetch?: FetchLike; hosts?: string[]; mainPid?: () => Promise<number | null> }) {
  const machines = options.machines ?? JSON.parse(readFileSync(resolve(root, 'machines.json'), 'utf8'));
  const store = new Store(options.db), clock = options.clock ?? Date.now;
  const configuredHosts = () => options.hosts ?? dashboardHosts();
  const startedAt = clock();
  let lastObservedAt = startedAt;
  const streams = new Set<ServerResponse>(), statuses = new Map<string, boolean>();
  const exec = options.exec ?? execFile;
  const quit = createQuit({ processes: id => usage.processes(id), online: machine => usage.snapshot(machine, clock(), false).online, exec, local: options.local, mainPid: options.mainPid, watch: options.collect !== false, collectorPids });
  const usage = new Usage(store.db, machines, quit.protection);
  function state(machine: Machine, now: number, event: true, history?: boolean): MachineEvent;
  function state(machine: Machine, now: number, event?: false, history?: boolean): WireMachine;
  function state(machine: Machine, now: number, event = false, history = true): WireMachine | MachineEvent {
    const value = event ? usage.event(machine, now) : usage.snapshot(machine, now, history);
    const limits: MachineLimits = { vpnMs: VPN_TIMEOUT, powerMs: POWER_TIMEOUT, updateMs: UPDATE_TIMEOUT, processes: PROCESS_LIMIT, maxTargets: MAX_TARGETS, usage: usageLimits(rules) };
    return { ...value, vpns: vpn.state(machine.id, value.vpns),
      ...(machine.collector === 'wsl' ? { power: power.state(machine.id) } : {}),
      updates: updates.state(machine), tempLimits: tempLimits(rules, machine.id), limits, attention: alerts.attention(machine.id) };
  }
  const vpn = createVpn({ exec, clock, vpns: id => usage.vpns(id), online: (machine, now) => usage.snapshot(machine, now, false).online, emit: (machine, now) => emit(machine, now), started: now => evaluateAlerts(now) });
  const power = createPower(exec, clock, (machine, now) => emit(machine, now), () => observeSuspension(clock()), now => { alerts.recover(now); power.resume(now); });
  const updates = createUpdates({ machines, exec: options.exec ?? detachedExec, clock, hangar: options.hangar ?? resolve(root, '../bin/hangar'), t3Db: options.t3Db ?? join(process.env.T3CODE_HOME ?? join(homedir(), '.t3'), 'userdata/statev2.sqlite'),
    schedule: options.updateChecks ?? options.collect !== false, kill: options.kill, online: machine => usage.snapshot(machine, clock(), false).online, emit: (machine, now) => emit(machine, now) });
  const rules = options.rules ?? loadRules(resolve(root, 'alerts.json'));
  const alerts = createAlerts({ db: store.db, dbPath: options.db, rules, vapid: options.vapid, fetch: options.fetch, clock, startedAt });
  function evaluateAlerts(now: number, completedDisconnects: { machine: string; vpn: string }[] = []) {
    const changed = new Set(alerts.observe(machines.map((m: Machine) => state(m, now, false, false)), now, completedDisconnects));
    for (const m of machines) if (changed.has(m.id)) emit(m, now);
  }
  const dist = options.dist ?? resolve(root, 'web/dist');
  // Names the page being served, so a tab still running an older one can tell it was rebuilt. Rehashed when index.html changes.
  let built = { mtime: -1, id: '' };
  function buildId() {
    try {
      const file = resolve(dist, 'index.html'), mtime = statSync(file).mtimeMs;
      if (mtime !== built.mtime) built = { mtime, id: createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12) };
    } catch { built = { mtime: -1, id: '' }; }
    return built.id;
  }
  buildId();
  for (const m of machines) statuses.set(m.id, usage.snapshot(m, clock()).online);
  function emit(machine: Machine, now: number) {
    const event = state(machine, now, true);
    statuses.set(machine.id, event.online);
    for (const stream of streams) stream.write(`event: machine\ndata: ${JSON.stringify(event)}\n\n`);
  }
  function intake(value: unknown) {
    const now = clock();
    // A rejected report says nothing about the Machine or about a suspension of the Dashboard, so only an accepted one is checked for a resume.
    const result = usage.intake(value, now, () => observeSuspension(now));
    if (result.status !== 204) return result.status;
    // The report that shows a disconnect done also clears `pending`; the Alerts must hear of it first.
    const completed = vpn.reconcile(result.machine, result.report.vpns);
    evaluateAlerts(now, completed); emit(result.machine, now); return 204;
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname;
      {
        // Every request must name this server, so a DNS-rebinding page can neither read nor change anything; changes must also come from the Dashboard itself.
        const address = server.address();
        const port = address && typeof address !== 'string' ? address.port : Number(process.env.HANGAR_DASHBOARD_PORT ?? 4318);
        const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...configuredHosts()]);
        const origins = new Set([...hosts].flatMap(h => /^(localhost|127\.0\.0\.1):\d+$/.test(h) ? [`http://${h}`, `https://${h}`] : [`https://${h}`]));
        const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
        if (!hosts.has((req.headers.host ?? '').toLowerCase()) || (req.method !== 'GET' && req.method !== 'HEAD' && path !== '/api/report' && ((origin !== undefined && !origins.has(origin)) || (site !== undefined && site !== 'same-origin' && site !== 'none')))) {
          res.writeHead(403).end(); return;
        }
      }
      if (req.method === 'POST' && path === '/api/report') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { res.writeHead(400).end(); return; } chunks.push(chunk); }
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
        res.writeHead(intake(value)).end(); return;
      }
      const minutePath = path.match(/^\/api\/machines\/([^/]+)\/minutes\/([^/]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && minutePath) {
        let id, t; try { id = decodeURIComponent(minutePath[1]); t = decodeURIComponent(minutePath[2]); } catch { res.writeHead(400).end(); return; }
        const value = machines.some((m: Machine) => m.id === id) ? usage.topApps(id, t, clock()) : null;
        res.writeHead(value ? 200 : 404, { 'Content-Type': 'application/json' }).end(value ? JSON.stringify(value) : ''); return;
      }
      const quitPath = path.match(/^\/api\/machines\/([^/]+)\/quit$/);
      if (req.method === 'POST' && quitPath) {
        let id; try { id = decodeURIComponent(quitPath[1]); } catch { res.writeHead(400).end(); return; }
        if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(400).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) { res.writeHead(400).end(); return; } chunks.push(chunk); }
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
        if (!validQuit(value)) { res.writeHead(400).end(); return; }
        const outcome = await quit.handle(machines.find((m: Machine) => m.id === id), value);
        if (outcome.status !== 200) { res.writeHead(outcome.status).end('message' in outcome ? outcome.message : ''); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results: outcome.results } satisfies QuitResponse)); return;
      }
      const powerPath = path.match(/^\/api\/machines\/([^/]+)\/power$/);
      if (req.method === 'POST' && powerPath) {
        let id; try { id = decodeURIComponent(powerPath[1]); } catch { res.writeHead(400).end(); return; }
        if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(400).end(); return; }
        let body = '', size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4096) { res.writeHead(400).end(); return; } body += chunk; }
        let value; try { value = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (!value || !['sleep', 'shutdown'].includes(value.action)) { res.writeHead(400).end(); return; }
        const machine = machines.find((m: Machine) => m.id === id);
        if (!machine || machine.collector !== 'wsl') { res.writeHead(404).end(); return; }
        const now = clock(); observeSuspension(now);
        if (!usage.snapshot(machine, now).online || power.state(id).pending) { res.writeHead(409).end(); return; }
        power.start(machine, value.action, now);
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify(power.state(id))); return;
      }
      const updatesPath = path.match(/^\/api\/machines\/([^/]+)\/updates(\/check)?$/);
      if (req.method === 'POST' && updatesPath) {
        let id; try { id = decodeURIComponent(updatesPath[1]); } catch { res.writeHead(400).end(); return; }
        if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(400).end(); return; }
        let body = '', size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4096) { res.writeHead(400).end(); return; } body += chunk; }
        let value: any = null;
        if (!updatesPath[2]) { try { value = JSON.parse(body); } catch { res.writeHead(400).end(); return; } if (!value || typeof value !== 'object' || !Array.isArray(value.items)) { res.writeHead(400).end(); return; } }
        const machine = machines.find((m: Machine) => m.id === id);
        if (!machine) { res.writeHead(404).end(); return; }
        observeSuspension(clock());
        const status = updatesPath[2] ? updates.check(machine) : updates.update(machine, value.items);
        res.writeHead(status, status === 202 && !updatesPath[2] ? { 'Content-Type': 'application/json' } : {}).end(status === 202 && !updatesPath[2] ? JSON.stringify(updates.state(machine)) : ''); return;
      }
      const threadsPath = path.match(/^\/api\/machines\/([^/]+)\/t3-threads$/);
      if (req.method === 'GET' && threadsPath) {
        let id; try { id = decodeURIComponent(threadsPath[1]); } catch { res.writeHead(400).end(); return; }
        const machine = machines.find((m: Machine) => m.id === id), value = machine ? updates.threads(machine) : null;
        res.writeHead(value ? 200 : 404, value ? { 'Content-Type': 'application/json' } : {}).end(value ? JSON.stringify(value) : ''); return;
      }
      const vpnPath = path.match(/^\/api\/machines\/([^/]+)\/vpns\/([^/]+)$/);
      if (req.method === 'POST' && vpnPath) {
        let id, name;
        try { id = decodeURIComponent(vpnPath[1]); name = decodeURIComponent(vpnPath[2]); } catch { res.writeHead(400).end(); return; }
        if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(400).end(); return; }
        let body = '', size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4096) { res.writeHead(400).end(); return; } body += chunk; }
        let value; try { value = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (!value || !['connect', 'disconnect'].includes(value.action)) { res.writeHead(400).end(); return; }
        const machine = machines.find((m: Machine) => m.id === id);
        if (!machine) { res.writeHead(404).end(); return; }
        const result = vpn.start(machine, name, value.action);
        res.writeHead(result.status).end(result.message); return;
      }
      if (path === '/api/alerts/key' || path === '/api/alerts/subscriptions' || path === '/api/alerts/test') {
        const allowed = path === '/api/alerts/key' ? ['GET', 'HEAD'] : path === '/api/alerts/test' ? ['POST'] : ['POST', 'DELETE'];
        if (!allowed.includes(req.method!)) { res.writeHead(404).end(); return; }
        if (!alerts.publicKey && req.method !== 'DELETE') { res.writeHead(503).end('Alerts are off: the VAPID key file is unusable'); return; }
        if (path === '/api/alerts/key') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ publicKey: alerts.publicKey })); return; }
        if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(400).end(); return; }
        let body = '', size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8192) { res.writeHead(400).end(); return; } body += chunk; }
        let value: any; try { value = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (path === '/api/alerts/subscriptions' && req.method === 'POST') {
          res.writeHead(alerts.subscribe(value, clock()) ? 201 : 400).end();
          return;
        }
        if (value === null || typeof value !== 'object' || typeof value.endpoint !== 'string') { res.writeHead(400).end(); return; }
        if (path === '/api/alerts/subscriptions') { alerts.unsubscribe(value.endpoint); res.writeHead(204).end(); return; }
        const result = await alerts.sendTest(value.endpoint);
        if (!result) { res.writeHead(404).end(); return; }
        if (result.ok) res.writeHead(204).end();
        else res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: result.status, ...(result.error ? { error: result.error } : {}) }));
        return;
      }
      const read = req.method === 'GET' || req.method === 'HEAD'; // node sends no body for HEAD
      if (read && path === '/api/machines') {
        const now = clock(); usage.prune(now);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ now: new Date(now).toISOString(), build: buildId(), machines: machines.map((m: Machine) => state(m, now)) } satisfies MachinesResponse)); return;
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
      }
      if (path === '/api' || path.startsWith('/api/') || !read) { res.writeHead(404).end(); return; }
      let decoded; try { decoded = decodeURIComponent(path); } catch { res.writeHead(400).end(); return; }
      if (decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) { res.writeHead(403).end(); return; }
      let file = resolve(dist, '.' + decoded);
      if (!statExists(file) || !statSync(file).isFile()) {
        if (extname(decoded)) { res.writeHead(404).end(); return; }
        file = resolve(dist, 'index.html');
        if (!statExists(file) || !statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end("The Dashboard page isn't built yet.\n"); return; }
      }
      const base = realpathSync(dist), real = realpathSync(file);
      if (!real.startsWith(base + sep)) { res.writeHead(403).end(); return; }
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
      res.writeHead(200, { 'Content-Type': types[extname(real)] ?? 'application/octet-stream', 'Cache-Control': file === resolve(dist, 'index.html') ? 'no-cache' : decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' }).end(readFileSync(real));
    } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  function observeSuspension(now: number) {
    // Check before evaluating reports or command callbacks too: either can run before the interval after resume.
    if (now - lastObservedAt > 35_000) {
      alerts.recover(now);
      power.resume(now);
    }
    lastObservedAt = now;
  }
  function tick() {
    const now = clock(); observeSuspension(now); power.tick(now); updates.tick(now); vpn.tick(now); usage.prune(now);
    for (const m of machines) if (statuses.get(m.id) && !usage.snapshot(m, now).online) emit(m, now);
    evaluateAlerts(now);
  }
  const offline = setInterval(tick, 5000);
  const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': heartbeat\n\n'); }, 20_000);
  const stops = options.collect === false ? [] : machines.filter((m: Machine) => m.collector === 'wsl').slice(0, 1).map((m: Machine) => startCollector(m.id, intake));
  return { server, tick, async idle() { await alerts.idle(); }, async close() { alerts.close(); power.close(); updates.close(); vpn.close(); quit.close(); clearInterval(offline); clearInterval(heartbeat); stops.forEach((stop: () => void) => stop()); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); } };
}
function statExists(path: string) { try { statSync(path); return true; } catch { return false; } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createDashboard({ db: process.env.HANGAR_DASHBOARD_DB ?? resolve(homedir(), '.local/state/hangar/dashboard.db') });
  app.server.listen(Number(process.env.HANGAR_DASHBOARD_PORT ?? 4318), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
}
