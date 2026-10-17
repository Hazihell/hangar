import { readFileSync } from 'node:fs';
import type { Machine } from './store.ts';
import type { Vpn } from './rules.ts';
export type Action = 'connect' | 'disconnect';
export type Exec = (file: string, args: string[], options: { timeout: number; encoding?: 'utf8'; maxBuffer?: number; detached?: boolean }, callback: (error: any, stdout: string, stderr: string) => void) => unknown;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function vpnCommand(machine: Machine, vpn: Vpn, action: Action) {
  if (machine.collector === 'wsl') {
    if (action === 'disconnect') return { file: '/mnt/c/Windows/System32/rasdial.exe', args: [vpn.name, '/disconnect'], timeout: 20_000 };
    const script = readFileSync(new URL('./vpn-windows.ps1', import.meta.url), 'utf8');
    const command = `& {\n${script}\n} -Name ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(vpn.name, 'utf8').toString('base64')}')))`;
    return { file: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], timeout: 80_000 };
  }
  if (!machine.ssh) return null;
  const command = action === 'disconnect' ? '/usr/sbin/scutil --nc stop' : vpn.kind === 'ppp' ? '/usr/sbin/networksetup -connectpppoeservice' : '/usr/sbin/scutil --nc start';
  return { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', machine.ssh, `${command} ${quote(vpn.name)}`], timeout: 30_000 };
}
export function commandError(error: any, stdout: string, stderr: string) {
  const last = (value: string) => {
    const clean = String(value).replace(/\r/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
    return clean.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#<') && !s.startsWith('<Objs')).at(-1);
  };
  return (last(stderr) || last(stdout) || (error.killed ? 'Command timed out' : `exit code ${error.code ?? 1}`)).slice(0, 512);
}
