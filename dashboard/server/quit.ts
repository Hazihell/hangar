import type { Process, Target } from './rules.ts';
import type { Machine } from './store.ts';
import { mayQuit } from './apps.ts';
import type { Protection } from './apps.ts';
import type { Exec } from './vpn.ts';
import { commandError } from './vpn.ts';
import { readProc } from './proc.ts';
export type Result = { pid: number; result: 'sent' | 'gone' | 'changed' | 'protected' | 'failed'; message?: string };
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
