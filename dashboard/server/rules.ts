import type { QuitRequest } from '../contract.ts';
export type { ReportVpn as Vpn, Process, QuitTarget as Target, QuitRequest } from '../contract.ts';
export const MAX_TARGETS = 200;
export const minute = (now: number) => Math.floor(now / 60_000) * 60_000;
export const cutoff = (now: number) => now - 86_400_000;
export const online = (at: number | null, now: number) => at !== null && now - at < 30_000;
export const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const pid = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
export const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(v);
export const token = (v: unknown) => typeof v === 'string' && v.length <= 64;
export function validQuit(v: unknown): v is QuitRequest {
  if (!object(v) || typeof v.force !== 'boolean') return false;
  if (v.app !== undefined) return v.targets === undefined && text(v.app) && (v.where === undefined || v.where === 'wsl');
  return v.where === undefined && Array.isArray(v.targets) && v.targets.length > 0 && v.targets.length <= MAX_TARGETS && v.targets.every(t => object(t) && pid(t.pid) && token(t.started) && (t.where === undefined || t.where === 'wsl'));
}
