import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import type { Exec } from './vpn.ts';
// On the PC, Windows' `tailscale serve` can't proxy to Ubuntu once mirrored networking breaks connections from Windows into Ubuntu (after sleep, or a VPN going down),
// yet the tailnet still reaches Ubuntu directly. So there the Dashboard answers HTTPS on the tailnet itself, with the certificate Tailscale issues for the PC's name.
const RETRY_MS = 60_000, REFRESH_MS = 24 * 60 * 60_000;
export function tailnetAddress(address: string | undefined) {
  const a = (address ?? '').toLowerCase().replace(/^::ffff:/, '');
  const v4 = a.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127; // 100.64.0.0/10
  return a.startsWith('fd7a:115c:a1e0:');
}
export function splitPem(pem: string) {
  const key = pem.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/)?.[0];
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return key && certs ? { key: key + '\n', cert: certs.join('\n') + '\n' } : null;
}
export function startTailnetHttps(options: { tailscale: string; exec: Exec; listener: RequestListener; port?: number; host?: string; accept?: (localAddress: string | undefined) => boolean; log?: (message: string) => void }) {
  const { tailscale, exec } = options, accept = options.accept ?? tailnetAddress, log = options.log ?? console.error;
  const server = createServer(options.listener);
  // Listening on every address is simplest across Tailscale restarts; anything that didn't arrive over the tailnet is dropped.
  server.on('connection', socket => { if (!accept(socket.localAddress)) socket.destroy(); });
  let timer: NodeJS.Timeout | undefined, closed = false, listening = false, pem = '';
  server.on('error', (error: NodeJS.ErrnoException) => {
    listening = false;
    log(`Dashboard HTTPS can't listen on port ${options.port ?? 443}: ${error.code === 'EACCES' ? "Ubuntu reserves it for root; run 'hangar install'" : error.code === 'EADDRINUSE' ? "taken, likely by Windows' 'tailscale serve'; run 'hangar install'" : error.message}`);
    schedule(RETRY_MS);
  });
  function schedule(ms: number) { clearTimeout(timer); if (!closed) timer = setTimeout(refresh, ms); }
  function refresh() {
    exec(tailscale, ['status', '--json'], { timeout: 10_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      let name = '';
      try { name = String(JSON.parse(stdout).Self?.DNSName ?? '').replace(/\.$/, ''); } catch {}
      if (closed) return;
      if (error || !name) { schedule(RETRY_MS); return; } // Tailscale may not be up yet at boot.
      // Tailscale keeps the certificate and renews it as it nears expiry, so a daily ask stays current.
      exec(tailscale, ['cert', '--cert-file', '-', '--key-file', '-', name], { timeout: 60_000, encoding: 'utf8' }, (error, stdout) => {
        const pair = error ? null : splitPem(stdout);
        if (closed) return;
        if (!pair) { log(`Dashboard HTTPS has no certificate for ${name}: ${error?.message ?? 'unreadable output'}`); schedule(RETRY_MS); return; }
        if (stdout !== pem) { server.setSecureContext(pair); pem = stdout; }
        if (!listening) { listening = true; server.listen(options.port ?? 443, options.host ?? '::'); }
        schedule(REFRESH_MS);
      });
    });
  }
  refresh();
  return { server, async close() { closed = true; clearTimeout(timer); server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); } };
}
