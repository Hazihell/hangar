export type Vpn = { name: string; status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting'; kind: 'ppp' | 'other' };
export type Process = { pid: number; name: string; app: string; cpu: number; ram: number; started: string; own: boolean };
export type Target = { pid: number; started: string; where?: 'wsl' };
export type Report = { machine: string; cpu: number; ram: { used: number; total: number }; disks: { name: string; used: number; total: number }[]; services?: Record<string, boolean>; vpns?: Vpn[]; processes?: Process[]; wsl?: Process[]; reporterPid?: number };
export type Point = { t: string; cpu: number; ram: number; disk: number };
export const minute = (now: number) => Math.floor(now / 60_000) * 60_000;
export const cutoff = (now: number) => now - 86_400_000;
export const online = (at: number | null, now: number) => at !== null && now - at < 30_000;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bytes = (v: unknown) => object(v) && finite(v.used) && finite(v.total) && v.total > 0 && v.used >= 0 && v.used <= v.total;
const pid = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(v);
const token = (v: unknown) => typeof v === 'string' && v.length <= 64;
const processRow = (p: unknown): p is Process => object(p) && pid(p.pid) && text(p.name) && text(p.app) && finite(p.cpu) && p.cpu >= 0 && p.cpu <= 100 && finite(p.ram) && p.ram >= 0 && token(p.started) && typeof p.own === 'boolean';
const processes = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 2000);
export type QuitRequest = { targets: Target[]; force: boolean; app?: never; where?: never } | { app: string; where?: 'wsl'; force: boolean; targets?: never };
export function validQuit(v: unknown): v is QuitRequest {
  if (!object(v) || typeof v.force !== 'boolean') return false;
  if (v.app !== undefined) return v.targets === undefined && text(v.app) && (v.where === undefined || v.where === 'wsl');
  return v.where === undefined && Array.isArray(v.targets) && v.targets.length > 0 && v.targets.length <= 200 && v.targets.every(t => object(t) && pid(t.pid) && token(t.started) && (t.where === undefined || t.where === 'wsl'));
}
export function validReport(v: unknown): v is Report {
  const valid = object(v) && typeof v.machine === 'string' && v.machine.length > 0 && finite(v.cpu) && v.cpu >= 0 && v.cpu <= 100 &&
    processes(v.processes) && processes(v.wsl) && (v.reporterPid === undefined || pid(v.reporterPid)) &&
    bytes(v.ram) && Array.isArray(v.disks) && v.disks.every(d => bytes(d) && typeof d.name === 'string' && d.name.length > 0) &&
    (v.services === undefined || (object(v.services) && Object.values(v.services).every(x => typeof x === 'boolean'))) &&
    (v.vpns === undefined || (Array.isArray(v.vpns) && v.vpns.every(vpn => object(vpn) && typeof vpn.name === 'string' && vpn.name.length > 0 && vpn.name.length <= 256 && !/^[\/-]|["\x00-\x1f\x7f-\x9f]/.test(vpn.name) && ['connected', 'disconnected', 'connecting', 'disconnecting'].includes(vpn.status) && ['ppp', 'other'].includes(vpn.kind))));
  if (!valid) return false;
  // Preserve healthy Usage when an OS Process disappears or produces a malformed row.
  if (v.processes !== undefined) v.processes = v.processes.filter(processRow);
  if (v.wsl !== undefined) v.wsl = v.wsl.filter(processRow);
  return true;
}
export function percentages(report: Report) {
  return { cpu: report.cpu, ram: report.ram.used / report.ram.total * 100, disk: Math.max(0, ...report.disks.map(d => d.used / d.total * 100)) };
}
export function average(previous: { cpu: number; ram: number; disk: number; count: number } | undefined, report: Report) {
  const p = percentages(report), n = previous?.count ?? 0;
  return { cpu: ((previous?.cpu ?? 0) * n + p.cpu) / (n + 1), ram: ((previous?.ram ?? 0) * n + p.ram) / (n + 1), disk: ((previous?.disk ?? 0) * n + p.disk) / (n + 1), count: n + 1 };
}
