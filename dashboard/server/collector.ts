import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { validReport } from './rules.ts';
import { createProcCollector } from './proc.ts';
export const collectorPids = new Set<number>();
// Kept as a script fragment so collector behavior can be exercised with stubbed OS results.
export const vpnScript = `
  $vpnFailed = $false
  $seenVpns = @{}
  $vpns = @(foreach ($all in @($false, $true)) {
    try {
      Get-VpnConnection -AllUserConnection:$all -ErrorAction Stop | ForEach-Object {
        if ($_.Name -notmatch 'tailscale' -and -not $seenVpns.ContainsKey($_.Name)) {
          $seenVpns[$_.Name] = $true
          $status = ([string]$_.ConnectionStatus).ToLowerInvariant()
          if ($status -notin @('connected','disconnected','connecting','disconnecting')) { $status = 'disconnected' }
          $kind = if ($_.TunnelType -in @('L2tp','Pptp')) { 'ppp' } else { 'other' }
          @{name=$_.Name;status=$status;kind=$kind}
        }
      }
    } catch { $vpnFailed = $true }
  })
  if (-not $vpnFailed) { $report.vpns = $vpns }
`;
export const processScript = `
  try {
    $sampleAt = [Diagnostics.Stopwatch]::GetTimestamp()
    $elapsed = ($sampleAt - $processAt) / [double][Diagnostics.Stopwatch]::Frequency
    $nextProcesses = @{}
    $processes = @(foreach ($p in (Get-Process -ErrorAction Stop)) {
      try {
        if ($p.Id -le 0) { continue }
        $started = ''; $own = $false; $ticks = [double]0
        try { $started = [string]$p.StartTime.Ticks; if ($started -ne '') { $own = $collectorSession -gt 0 -and $p.SessionId -eq $collectorSession; $ticks = $p.TotalProcessorTime.TotalSeconds } } catch { $started = ''; $own = $false }
        $key = [string]$p.Id + ':' + $started
        $percent = [double]0
        if ($started -ne '') {
          if ($previousProcesses.ContainsKey($key) -and $elapsed -gt 0) { $percent = [Math]::Min(100, [Math]::Max(0, ($ticks - $previousProcesses[$key]) / $elapsed / $logicalCpus * 100)) }
          $nextProcesses[$key] = $ticks
        }
        $name = $p.ProcessName -replace '[\\x00-\\x1f\\x7f-\\x9f]', ''
        if ($name -notmatch '\\.exe$') { $name += '.exe' }
        @{pid=$p.Id; name=$name; app=($name -replace '\\.exe$',''); cpu=$percent; ram=[double]$p.WorkingSet64; started=$started; own=$own}
      } catch { } finally { $p.Dispose() }
    })
    $retained = @{}
    @($processes | Sort-Object -Property { $_.ram } -Descending | Select-Object -First 300) + @($processes | Sort-Object -Property { $_.cpu } -Descending | Select-Object -First 100) | ForEach-Object { $retained[$_.pid] = $_ }
    $report.processes = @($retained.Values | Sort-Object -Property { $_.ram } -Descending)
    $previousProcesses = $nextProcesses; $processAt = $sampleAt
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
`;
export const script = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cpu = New-Object System.Diagnostics.PerformanceCounter('Processor','% Processor Time','_Total')
$available = New-Object System.Diagnostics.PerformanceCounter('Memory','Available Bytes')
$total = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$null = $cpu.NextValue()
$logicalCpus = [Environment]::ProcessorCount
$collectorSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$previousProcesses = @{}
$processAt = [Diagnostics.Stopwatch]::GetTimestamp()
@{collectorPid=$PID;logicalCpus=$logicalCpus} | ConvertTo-Json -Compress
while ($true) {
  Start-Sleep -Seconds 10
  try {
  $disks = @(foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
    try {
      if ($drive.DriveType -ne 'Fixed' -or -not $drive.IsReady) { continue }
      $size = [double]$drive.TotalSize
      if ($size -le 0) { continue }
      @{name=$drive.Name.TrimEnd('\\'); used=[double]($size - $drive.TotalFreeSpace); total=$size}
    } catch { [Console]::Error.WriteLine($_.Exception.Message) }
  })
  $report = @{cpu=[Math]::Min([double]100,[Math]::Max([double]0,[double]$cpu.NextValue())); ram=@{used=[Math]::Max([double]0,($total - [double]$available.NextValue()));total=$total};disks=$disks}
  ${vpnScript}
  ${processScript}
  $report | ConvertTo-Json -Depth 4 -Compress
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
}`;
export function reportFromLine(line: string, machine: string, t3: boolean) {
  const value = JSON.parse(line.replace(/^\uFEFF/, ''));
  const report = { ...value, machine, services: { t3 },
    disks: Array.isArray(value.disks) ? value.disks.filter((d: any) => d.total !== 0) : value.disks };
  if (!validReport(report)) throw new Error('invalid Usage');
  return report;
}
export function startCollector(machine: string, intake: (report: unknown) => number) {
  let stopped = false, child: ReturnType<typeof spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined, delay = 1000;
  try { if (!/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return () => {}; } catch { return () => {}; }
  let logicalCpus = 1;
  const sampleProc = createProcCollector({ cpus: () => logicalCpus });
  try { sampleProc(); } catch (error) { console.error('WSL collector:', error); }
  function launch() {
    const current = child = spawn('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastValid = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastValid >= 45_000) { console.error('Windows collector: no valid report for 45 seconds; restarting'); current.kill(); }
    }, 5000);
    const lines = createInterface({ input: current.stdout! });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (Number.isSafeInteger(value.collectorPid) && value.collectorPid > 0) { collectorPids.add(value.collectorPid); if (Number.isSafeInteger(value.logicalCpus) && value.logicalCpus > 0) logicalCpus = value.logicalCpus; return; }
      } catch { /* Report parsing below provides the diagnostic. */ }
      execFile('systemctl', ['--user', 'is-active', '--quiet', 't3code.service'], { timeout: 3000 }, error => {
        if (stopped || current !== child || current.exitCode !== null || current.killed) return;
        try {
          const report = reportFromLine(line, machine, !error);
          try { report.wsl = sampleProc(); } catch (error) { console.error('WSL collector:', error); }
          const result = intake(report);
          if (result !== 204) console.error('Windows collector: report rejected:', result);
          else { lastValid = Date.now(); delay = 1000; }
        } catch (error) { console.error('Windows collector:', error); }
      });
    });
    current.stderr!.on('data', data => console.error('Windows collector:', String(data).trim()));
    current.on('error', error => console.error('Windows collector:', error.message));
    current.once('close', () => { clearInterval(watchdog); collectorPids.clear(); lines.close(); if (!stopped) { timer = setTimeout(launch, delay); delay = Math.min(delay * 2, 60_000); } });
  }
  launch();
  return () => { stopped = true; clearTimeout(timer); child?.kill(); };
}
