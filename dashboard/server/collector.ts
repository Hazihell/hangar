import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { validReport } from './rules.ts';
export const script = `
$ErrorActionPreference = 'Stop'
$cpu = New-Object System.Diagnostics.PerformanceCounter('Processor','% Processor Time','_Total')
$available = New-Object System.Diagnostics.PerformanceCounter('Memory','Available Bytes')
$total = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$null = $cpu.NextValue()
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
  @{cpu=[Math]::Min([double]100,[Math]::Max([double]0,[double]$cpu.NextValue())); ram=@{used=[Math]::Max([double]0,($total - [double]$available.NextValue()));total=$total};disks=$disks} | ConvertTo-Json -Depth 4 -Compress
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
  function launch() {
    const current = child = spawn('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastValid = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastValid >= 45_000) { console.error('Windows collector: no valid report for 45 seconds; restarting'); current.kill(); }
    }, 5000);
    const lines = createInterface({ input: current.stdout! });
    lines.on('line', line => {
      execFile('systemctl', ['--user', 'is-active', '--quiet', 't3code.service'], { timeout: 3000 }, error => {
        if (stopped || current !== child || current.exitCode !== null || current.killed) return;
        try {
          const result = intake(reportFromLine(line, machine, !error));
          if (result !== 204) console.error('Windows collector: report rejected:', result);
          else { lastValid = Date.now(); delay = 1000; }
        } catch (error) { console.error('Windows collector:', error); }
      });
    });
    current.stderr!.on('data', data => console.error('Windows collector:', String(data).trim()));
    current.on('error', error => console.error('Windows collector:', error.message));
    current.once('close', () => { clearInterval(watchdog); lines.close(); if (!stopped) { timer = setTimeout(launch, delay); delay = Math.min(delay * 2, 60_000); } });
  }
  launch();
  return () => { stopped = true; clearTimeout(timer); child?.kill(); };
}
