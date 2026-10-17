import { spawn, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Process } from './rules.ts';
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
// HWiNFO64 publishes the readings ticked for Gadget reporting as numbered values (Label0, ValueRaw0...) with holes; the CPU is found by its label.
export const tempScript = `
  try {
    $vsb = Get-ItemProperty -Path 'HKCU:\\Software\\HWiNFO64\\VSB' -ErrorAction Stop
    $label = @($vsb.PSObject.Properties | Where-Object { $_.Name -match '^Label\\d+$' -and $_.Value -eq 'CPU (Tctl/Tdie)' })[0]
    if ($label) {
      $celsius = [double]::Parse([string]$vsb.('ValueRaw' + $label.Name.Substring(5)), [Globalization.CultureInfo]::InvariantCulture)
      if (-not [double]::IsNaN($celsius) -and -not [double]::IsInfinity($celsius)) { $report.temps = @{cpu=$celsius} }
    }
  } catch { }
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
  ${tempScript}
  ${processScript}
  $report | ConvertTo-Json -Depth 4 -Compress
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
}`;
const nvidiaSmi = '/usr/lib/wsl/lib/nvidia-smi';
/** The first GPU's degrees Celsius from `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits`. */
function gpuTemperature(output: string) {
  const first = output.split('\n')[0].trim();
  return /^-?\d+(\.\d+)?$/.test(first) ? Number(first) : undefined;
}
function reportFromLine(line: string, machine: string, t3: boolean, gpu?: number) {
  const value = JSON.parse(line.replace(/^\uFEFF/, ''));
  const temps = { ...value.temps, ...(gpu === undefined ? {} : { gpu }) };
  const report = { ...value, machine, services: { t3 }, ...(Object.keys(temps).length ? { temps } : {}),
    disks: Array.isArray(value.disks) ? value.disks.filter((d: any) => d.total !== 0) : value.disks };
  if (!validReport(report)) throw new Error('invalid Usage');
  return report;
}
/** A command's output, or null if it is missing, fails or takes over 3 s. */
const probe = (file: string, args: string[]) => new Promise<string | null>(resolve => execFile(file, args, { timeout: 3000, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout)));
type ReporterEvents = { line: (line: string) => void; error: (message: string) => void; close: () => void };
export type CollectorProcess = {
  available: () => boolean;
  start: (events: ReporterEvents) => () => void;
  probe: (file: string, args: string[]) => Promise<string | null>;
  createSampler: (cpus: () => number) => () => Process[];
};
export type CollectorClock = {
  now: () => number;
  after: (ms: number, run: () => void) => () => void;
  every: (ms: number, run: () => void) => () => void;
};
const realProcess: CollectorProcess = {
  available: () => {
    try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
  },
  start: events => {
    const child = spawn('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', events.line);
    child.stderr.on('data', data => events.error(String(data).trim()));
    child.on('error', error => events.error(error.message));
    child.once('close', () => { lines.close(); events.close(); });
    return () => { lines.close(); child.kill(); };
  },
  probe,
  createSampler: cpus => createProcCollector({ cpus }),
};
const clock: CollectorClock = {
  now: () => Date.now(),
  after: (ms, run) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
  every: (ms, run) => { const timer = setInterval(run, ms); return () => clearInterval(timer); },
};
/** Reports reach intake in line order, after both probes. Stop discards pending reports. */
export function startCollector(machine: string, intake: (report: unknown) => number,
  options: { process?: CollectorProcess; clock?: CollectorClock } = {}) {
  const os = options.process ?? realProcess, time = options.clock ?? clock;
  if (!os.available()) return () => {};
  let stopped = false, cancelRestart: (() => void) | undefined, delay = 1000, logicalCpus = 1;
  let session: { active: boolean; kill: () => void; cancelWatchdog: () => void } | undefined;
  const sampleProc = os.createSampler(() => logicalCpus);
  try { sampleProc(); } catch (error) { console.error('WSL collector:', error); }
  function launch() {
    const current = session = { active: true, kill: () => {}, cancelWatchdog: () => {} };
    let lastValid = time.now(), pending = Promise.resolve();
    function retire() {
      current.active = false;
      current.cancelWatchdog();
      collectorPids.clear();
    }
    current.cancelWatchdog = time.every(5000, () => {
      if (time.now() - lastValid >= 45_000) {
        console.error('Windows collector: no valid report for 45 seconds; restarting');
        retire();
        current.kill();
      }
    });
    current.kill = os.start({
      line: line => {
        if (stopped || !current.active) return;
        try {
          const value = JSON.parse(line.replace(/^\uFEFF/, ''));
          if (Number.isSafeInteger(value.collectorPid) && value.collectorPid > 0) {
            collectorPids.add(value.collectorPid);
            if (Number.isSafeInteger(value.logicalCpus) && value.logicalCpus > 0) logicalCpus = value.logicalCpus;
            return;
          }
        } catch { /* Report parsing below provides the diagnostic. */ }
        const probes = Promise.all([
          os.probe('systemctl', ['--user', 'is-active', '--quiet', 't3code.service']).catch(() => null),
          os.probe(nvidiaSmi, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits']).catch(() => null),
        ]);
        pending = pending.then(async () => {
          const [service, smi] = await probes;
          if (stopped || !current.active) return;
          const report = reportFromLine(line, machine, service !== null, smi === null ? undefined : gpuTemperature(smi));
          try { report.wsl = sampleProc(); } catch (error) { console.error('WSL collector:', error); }
          const result = intake(report);
          if (result !== 204) console.error('Windows collector: report rejected:', result);
          else { lastValid = time.now(); delay = 1000; }
        }).catch(error => console.error('Windows collector:', error));
      },
      error: message => { if (!stopped) console.error('Windows collector:', message); },
      close: () => {
        retire();
        if (!stopped) { cancelRestart = time.after(delay, launch); delay = Math.min(delay * 2, 60_000); }
      },
    });
  }
  launch();
  return () => {
    if (stopped) return;
    stopped = true;
    cancelRestart?.();
    if (session) { session.active = false; session.cancelWatchdog(); session.kill(); }
    collectorPids.clear();
  };
}
