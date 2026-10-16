import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.ts';
import type { Machine } from './store.ts';
import { validReport } from './rules.ts';
import { startCollector } from './collector.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
export function createDashboard(options: { db: string; machines?: Machine[]; clock?: () => number; collect?: boolean; dist?: string }) {
  const machines = options.machines ?? JSON.parse(readFileSync(resolve(root, 'machines.json'), 'utf8'));
  const store = new Store(options.db, machines), clock = options.clock ?? Date.now;
  const streams = new Set<ServerResponse>(), statuses = new Map<string, boolean>();
  const dist = options.dist ?? resolve(root, 'web/dist');
  for (const m of machines) statuses.set(m.id, store.snapshot(m, clock()).online);
  function emit(machine: Machine, now: number) {
    const event = store.event(machine, now);
    statuses.set(machine.id, event.online);
    for (const stream of streams) stream.write(`event: machine\ndata: ${JSON.stringify(event)}\n\n`);
  }
  function intake(value: unknown) {
    if (!validReport(value)) return 400;
    const m = machines.find((m: Machine) => m.id === value.machine);
    if (!m) return 404;
    const report = { machine: value.machine, cpu: value.cpu, ram: { used: value.ram.used, total: value.ram.total },
      disks: value.disks.map(d => ({ name: d.name, used: d.used, total: d.total })),
      ...(value.services === undefined ? {} : { services: value.services }) };
    const now = clock();
    try { store.intake(report, now); } catch (error) { console.error('Dashboard intake:', error); return 500; }
    emit(m, now); return 204;
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (req.method === 'POST' && path === '/api/report') {
        let body = '', size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { res.writeHead(400).end(); return; } body += chunk; }
        let value; try { value = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        res.writeHead(intake(value)).end(); return;
      }
      const read = req.method === 'GET' || req.method === 'HEAD'; // node sends no body for HEAD
      if (read && path === '/api/machines') {
        const now = clock(); store.prune(now);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ now: new Date(now).toISOString(), machines: machines.map((m: Machine) => store.snapshot(m, now)) })); return;
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
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[extname(real)] ?? 'application/octet-stream', 'Cache-Control': file === resolve(dist, 'index.html') ? 'no-cache' : decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' }).end(readFileSync(real));
    } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  function tick() {
    const now = clock(); store.prune(now);
    for (const m of machines) if (statuses.get(m.id) && !store.snapshot(m, now).online) emit(m, now);
  }
  const offline = setInterval(tick, 5000);
  const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': heartbeat\n\n'); }, 20_000);
  const stops = options.collect === false ? [] : machines.filter((m: Machine) => m.collector === 'wsl').slice(0, 1).map((m: Machine) => startCollector(m.id, intake));
  return { server, tick, async close() { clearInterval(offline); clearInterval(heartbeat); stops.forEach((stop: () => void) => stop()); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); } };
}
function statExists(path: string) { try { statSync(path); return true; } catch { return false; } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createDashboard({ db: process.env.HANGAR_DASHBOARD_DB ?? resolve(homedir(), '.local/state/hangar/dashboard.db') });
  app.server.listen(Number(process.env.HANGAR_DASHBOARD_PORT ?? 4318), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
}
