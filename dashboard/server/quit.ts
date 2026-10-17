import type { Process, QuitRequest, Report, QuitTarget as Target, QuitResponse, QuitProcessResult as Result } from '../contract.ts';
import type { Machine } from './store.ts';
import type { Exec } from './vpn.ts';
import { commandError } from './vpn.ts';
import { readProc } from './proc.ts';
import { execFile } from 'node:child_process';
// The Quit module: which Processes may be quit (policy), which of them a request means (expansion), and the checks each Machine's own adapter makes right before acting.
export type Protection = { windows?: Set<number>; wsl?: Set<number>; t3?: number };
const windows = new Set('vmmemwsl vmmem wsl wslhost wslservice wslrelay svchost startmenuexperiencehost shellexperiencehost textinputhost searchhost explorer dwm csrss winlogon ctfmon sihost fontdrvhost runtimebroker tailscale-ipn tailscaled'.split(' '));
const mac = new Set('windowserver loginwindow dock finder systemuiserver launchd sshd sshd-session tailscaled mac-reporter.sh'.split(' '));
export const executable = (name: string) => name.toLowerCase().replace(/\.exe$/, '');
export function mayQuit(p: Process, machine: Machine, where: 'wsl' | undefined, protection: Protection = {}, reporterPid?: number) {
  if (!p.own || !p.started) return false;
  const name = executable(p.name);
  if (where === 'wsl') return p.pid !== 1 && !['systemd', 'init', 'sshd', 'sshd-session', 'tailscaled'].includes(name) && !protection.wsl?.has(p.pid) && p.pid !== protection.t3;
  if (machine.collector === 'wsl') return !windows.has(name) && !protection.windows?.has(p.pid);
  return !name.startsWith('sshd') && !mac.has(name) && p.app.toLowerCase() !== 'tailscale' && p.pid !== reporterPid;
}
export type { QuitProcessResult as Result } from '../contract.ts';
export type Local = { read: typeof readProc; quit: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void; uid: number };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const macScript = `force=$1; reporter=$2; shift 2
uid=$(id -u)
while [ "$#" -gt 0 ]; do
  pid=$1; expected=$2; shift 2
  started=$(LC_ALL=C ps -o lstart= -p "$pid" | awk '{$1=$1;print}')
  result=sent
  if [ -z "$started" ]; then result=gone
  elif [ "$started" != "$expected" ]; then result=changed
  else
    owner=$(ps -o uid= -p "$pid" | tr -d ' ')
    name=$(ps -o comm= -p "$pid")
    case "$name" in */WindowServer|*/loginwindow|*/Dock|*/Finder|*/SystemUIServer|*/launchd|sshd*|*/sshd*|*/tailscaled|*/mac-reporter.sh|*/Tailscale.app/*) result=protected;; esac
    [ "$owner" = "$uid" ] || result=protected
    ancestor=$$
    while [ "$ancestor" -gt 1 ] 2>/dev/null; do
      [ "$ancestor" != "$pid" ] || { result=protected; break; }
      ancestor=$(ps -o ppid= -p "$ancestor" | tr -d ' ')
    done
    ancestor=$pid
    while [ "$ancestor" -gt 1 ] 2>/dev/null; do
      [ "$ancestor" != "$reporter" ] || { result=protected; break; }
      command=$(ps -o command= -p "$ancestor")
      case "$command" in */mac-reporter.sh*) result=protected; break;; esac
      ancestor=$(ps -o ppid= -p "$ancestor" | tr -d ' ')
    done
    if [ "$result" = sent ]; then
      if [ "$force" = 1 ]; then signal=KILL; else signal=TERM; fi
      message=$(kill -"$signal" "$pid" 2>&1) || result=failed
    fi
  fi
  detail=''
  if [ "$result" = failed ]; then detail=$(printf '%s' "$message" | /usr/bin/base64 | tr -d '\\r\\n'); fi
  printf '%s\\t%s\\t%s\\n' "$pid" "$result" "$detail"
done`;
export function quitCommand(machine: Machine, targets: Target[], force: boolean, protection: Protection = {}, reporterPid = 0) {
  if (machine.collector === 'wsl') {
    const data = Buffer.from(JSON.stringify({ targets, force, protected: [...protection.windows ?? []] }), 'utf8').toString('base64');
    const source = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$session = (Get-Process -Id $PID).SessionId
$results = @(foreach ($target in $data.targets) {
  $result = 'sent'; $message = $null
  $p = Get-Process -Id $target.pid -ErrorAction SilentlyContinue
  if ($null -eq $p) { $result = 'gone' }
  else {
    try {
      $null = $p.Handle
      if ([string]$p.StartTime.Ticks -cne $target.started) { $result = 'changed' }
      elseif ($session -le 0 -or $p.SessionId -le 0 -or $p.SessionId -ne $session -or $p.ProcessName -in @('vmmemWSL','vmmem','wsl','wslhost','wslservice','wslrelay','svchost','StartMenuExperienceHost','ShellExperienceHost','TextInputHost','SearchHost','explorer','dwm','csrss','winlogon','ctfmon','sihost','fontdrvhost','RuntimeBroker','tailscale-ipn','tailscaled') -or $p.Id -in $data.protected) { $result = 'protected' }
      else {
        if ($data.force) { $p.Kill() }
        else {
          $p.Refresh()
          if ([string]$p.StartTime.Ticks -cne $target.started) { $result = 'changed' }
          else {
            $message = (& taskkill.exe /PID ([string]$p.Id) 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) { $result = 'failed' }
          }
        }
      }
    } catch { $result = 'failed'; $message = $_.Exception.Message } finally { $p.Dispose() }
  }
  $row = @{pid=[int]$target.pid;result=$result}
  if ($result -eq 'failed') { $row.message = $message }
  $row
})
ConvertTo-Json -InputObject $results -Compress`;
    return { file: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')] };
  }
  return machine.ssh ? { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', machine.ssh, `sh -c ${quote(macScript)} sh ${force ? 1 : 0} ${reporterPid} ${targets.map(t => `${t.pid} ${quote(t.started)}`).join(' ')}`] } : null;
}
export async function quitProcesses(machine: Machine, targets: Target[], force: boolean, report: { processes?: Process[]; wsl?: Process[]; reporterPid?: number }, protection: Protection, exec: Exec, local: Local = { read: readProc, quit: process.kill, uid: process.getuid!() }): Promise<Result[]> {
  const results: Result[] = [], remote: Target[] = [], indexes: number[] = [];
  for (const target of targets) {
    const list = target.where === 'wsl' ? report.wsl : report.processes;
    const p = list?.find(p => p.pid === target.pid);
    let result: Result['result'] | undefined;
    if (!p || (target.where && machine.collector !== 'wsl')) result = 'gone';
    else if (!mayQuit(p, machine, target.where, protection, report.reporterPid)) result = 'protected';
    else if (p.started !== target.started) result = 'changed';
    if (result) { results.push({ pid: target.pid, result }); continue; }
    if (target.where === 'wsl') {
      try {
        const current = local.read(target.pid);
        if (!current) result = 'gone';
        else if (current.started !== target.started) result = 'changed';
        else if (!mayQuit({ ...p!, name: current.name, own: current.uid === local.uid }, machine, 'wsl', protection)) result = 'protected';
        else { local.quit(target.pid, force ? 'SIGKILL' : 'SIGTERM'); result = 'sent'; }
        results.push({ pid: target.pid, result });
      } catch (error: any) { results.push({ pid: target.pid, result: error.code === 'ESRCH' || error.code === 'ENOENT' ? 'gone' : 'failed', ...(error.code === 'ESRCH' || error.code === 'ENOENT' ? {} : { message: String(error.message).slice(0, 512) }) }); }
    } else { indexes.push(results.length); remote.push(target); results.push({ pid: target.pid, result: 'failed', message: 'No result from Machine' }); }
  }
  if (!remote.length) return results;
  // Nested Base64 encoding must fit Windows' 32,767-character command line limit,
  // including the PowerShell program and the largest allowed identity tokens.
  for (let offset = 0; offset < remote.length;) {
    let size = machine.collector === 'wsl' ? Math.min(80, remote.length - offset) : remote.length;
    let batch = remote.slice(offset, offset + size);
    let command = quitCommand(machine, batch, force, protection, report.reporterPid);
    // Measure the actual encoded program: Unicode and JSON escapes expand tokens.
    while (command && machine.collector === 'wsl' && command.file.length + command.args.join(' ').length + 64 >= 32767 && size > 1) {
      size = Math.max(1, Math.floor(size / 2));
      batch = remote.slice(offset, offset + size);
      command = quitCommand(machine, batch, force, protection, report.reporterPid);
    }
    const batchIndexes = indexes.slice(offset, offset + batch.length);
    offset += batch.length;
    if (!command) return results;
    await new Promise<void>(resolve => {
      const done = (error: any, stdout: string, stderr: string) => {
        try {
          const parsed: Result[] = machine.collector === 'wsl' ? JSON.parse(stdout.replace(/^\uFEFF/, '').trim().split(/\r?\n/).at(-1)!) : stdout.trim().split(/\r?\n/).map(line => { const [pid, result, message] = line.split('\t'); return { pid: Number(pid), result: result as Result['result'], ...(result === 'failed' ? { message: message ? Buffer.from(message, 'base64').toString('utf8') : 'Quit was refused by the Machine' } : {}) }; });
          batchIndexes.forEach((index, i) => {
            const row = parsed[i];
            if (row?.pid === batch[i].pid && ['sent', 'gone', 'changed', 'protected', 'failed'].includes(row.result)) results[index] = { pid: row.pid, result: row.result, ...(row.result === 'failed' ? { message: String(row.message ?? 'Quit failed').slice(0, 512) } : {}) };

          });
        } catch { for (const i of batchIndexes) results[i].message = error ? commandError(error, stdout, stderr) : 'Invalid result from Machine'; }
        resolve();
      };
      try { exec(command.file, command.args, { timeout: 20_000, encoding: 'utf8' }, done); } catch (error) { done(error, '', ''); }
    });
  }
  return results;
}

export type QuitOptions = {
  /** The latest Process lists a Machine reported, if any. */
  processes: (machineId: string) => { processes?: Process[]; wsl?: Process[]; reporterPid?: number } | undefined;
  online: (machine: Machine) => boolean;
  exec: Exec;
  local?: Local;
  /** The T3 service's main PID, or null if it can't be told. */
  mainPid?: () => Promise<number | null>;
  /** Keep T3's PID current on a timer, as well as right before a WSL Quit. */
  watch: boolean;
  /** The Windows collector's own PIDs, which may never be quit. */
  collectorPids?: Set<number>;
};
export type Outcome = ({ status: 200 } & QuitResponse) | { status: 404 | 409 } | { status: 503; message: string };
const systemctl = () => new Promise<number | null>(resolve => {
  execFile('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 't3code.service'], { timeout: 3000, encoding: 'utf8' }, (error, stdout) => resolve(!error && /^\d+\s*$/.test(stdout) ? Number(stdout.trim()) : null));
});
/**
 * Quit for a Dashboard: owns the Protection the Dashboard's Apps are read through, keeps T3's own PID in it current,
 * and turns a Quit request into one result per Process, each checked against the Machine as it acts.
 */
export function createQuit(options: QuitOptions) {
  const mainPid = options.mainPid ?? systemctl;
  const ancestors = new Set<number>();
  let ancestor = process.pid;
  while (ancestor > 0 && !ancestors.has(ancestor)) { ancestors.add(ancestor); try { ancestor = readProc(ancestor)?.ppid ?? 0; } catch { break; } }
  const protection: Protection = { windows: options.collectorPids ?? new Set(), wsl: ancestors };
  const valid = (pid: number | null): pid is number => pid !== null && Number.isSafeInteger(pid) && pid >= 0;
  let refreshing = false;
  function refresh() {
    if (refreshing || !options.watch) return;
    refreshing = true;
    Promise.resolve().then(mainPid).then(pid => { if (valid(pid)) protection.t3 = pid; }, () => {}).finally(() => { refreshing = false; });
  }
  refresh();
  const timer = setInterval(refresh, 30_000);
  return {
    /** What the Dashboard reads Apps through; this module keeps it current. */
    protection,
    /** Quits what `request` means on `machine`; 404 if it can't be quit from here, 409 if Offline, 503 if T3's PID can't be verified for WSL. */
    async handle(machine: Machine | undefined, request: QuitRequest): Promise<Outcome> {
      if (!machine || (machine.collector !== 'wsl' && !machine.ssh)) return { status: 404 };
      if (!options.online(machine)) return { status: 409 };
      const report = options.processes(machine.id) ?? {};
      if (request.app !== undefined ? request.where === 'wsl' : request.targets.some(t => t.where === 'wsl')) {
        let current: number | null;
        try { current = await mainPid(); } catch { current = null; }
        if (!valid(current)) return { status: 503, message: 'Cannot verify the T3 service Process' };
        protection.t3 = current;
      }
      const targets: Target[] = request.app === undefined ? request.targets : (request.where === 'wsl' ? report.wsl : report.processes ?? [])?.filter(p => p.app === request.app && mayQuit(p, machine, request.where, protection, report.reporterPid)).map(p => ({ pid: p.pid, started: p.started, ...(request.where === 'wsl' ? { where: 'wsl' as const } : {}) })) ?? [];
      // Each result names the Process it's about (pid plus started token), so the page can follow and Force quit exactly that Process even if the PID is reused.
      const results = (await quitProcesses(machine, targets, request.force, report, protection, options.exec, options.local)).map((r, i) => ({ ...r, started: targets[i].started, ...(targets[i].where ? { where: targets[i].where } : {}) }));
      return { status: 200, results };
    },
    close() { clearInterval(timer); },
  };
}
