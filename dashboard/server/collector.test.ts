import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
import { startCollector, collectorPids, vpnScript, tempScript, processScript, script } from './collector.ts';
import type { CollectorProcess, CollectorClock } from './collector.ts';

function deferred() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const line = (cpu = 10, extra = {}) => JSON.stringify({ cpu, ram: { used: 1, total: 2 }, disks: [], ...extra });
function session(intake: (report: any) => number = () => 204) {
  let now = 0, available = true, cpus = () => 1;
  const timers = new Set<{ at: number; ms?: number; run: () => void }>();
  const schedule = (ms: number, run: () => void, repeat = false) => {
    const timer = { at: now + ms, ms: repeat ? ms : undefined, run };
    timers.add(timer);
    return () => { timers.delete(timer); };
  };
  const clock: CollectorClock = { now: () => now, after: (ms, run) => schedule(ms, run), every: (ms, run) => schedule(ms, run, true) };
  const reporters: { events: Parameters<CollectorProcess['start']>[0]; kills: number; close: () => void }[] = [];
  const probes = { service: [] as ReturnType<typeof deferred>[], gpu: [] as ReturnType<typeof deferred>[] };
  const reports: any[] = [];
  const process: CollectorProcess = {
    available: () => available,
    start: events => {
      let closed = false;
      const reporter = { events, kills: 0, close: () => { if (!closed) { closed = true; events.close(); } } };
      reporters.push(reporter);
      return () => { if (!closed) { reporter.kills++; reporter.close(); } };
    },
    probe: file => { const result = deferred(); probes[file === 'systemctl' ? 'service' : 'gpu'].push(result); return result.promise; },
    createSampler: count => { cpus = count; return () => [{ pid: 2, name: 'node', app: 'node', started: '1', own: true, cpu: 80 / cpus(), ram: 4 }]; },
  };
  let stop = () => {};
  return {
    reporters, probes, reports, timers,
    stop() { stop(); },
    start() { stop = startCollector('pc', report => { reports.push(report); return intake(report); }, { process, clock }); },
    unavailable() { available = false; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        if (next.ms) next.at += next.ms; else timers.delete(next);
        next.run();
      }
      now = end;
    },
    send(value: string) { reporters.at(-1)!.events.line(value); },
    finishAll() { for (const probe of [...probes.service, ...probes.gpu]) probe.resolve(null); },
    finish(index: number, service: string | null = '', gpu: string | null = null) {
      probes.service[index].resolve(service); probes.gpu[index].resolve(gpu);
    },
  };
}

test('collection waits for both probes and delivers enriched Usage in line order', async () => {
  const s = session(); s.start();
  s.send('\uFEFF{"collectorPid":123,"logicalCpus":8}');
  assert.equal(collectorPids.has(123), true);
  s.send('\uFEFF' + line(12.5, { disks: [{ name: 'C:', used: 30, total: 100 }, { name: 'D:', used: 0, total: 0 }], temps: { cpu: 49.5 }, vpns: [{ name: 'Steeprock', status: 'connected', kind: 'ppp' }] }));
  s.send(line(20));
  s.finish(1, null, 'N/A'); await flush();
  assert.equal(s.reports.length, 0);
  s.probes.service[0].resolve(''); await flush();
  assert.equal(s.reports.length, 0);
  s.probes.gpu[0].resolve('38\n41\n'); await flush();
  assert.deepEqual(s.reports.map(r => r.cpu), [12.5, 20]);
  assert.deepEqual(s.reports[0], { machine: 'pc', cpu: 12.5, ram: { used: 1, total: 2 }, disks: [{ name: 'C:', used: 30, total: 100 }], temps: { cpu: 49.5, gpu: 38 }, vpns: [{ name: 'Steeprock', status: 'connected', kind: 'ppp' }], services: { t3: true }, wsl: [{ pid: 2, name: 'node', app: 'node', started: '1', own: true, cpu: 10, ram: 4 }] });
  assert.equal(s.reports[1].services.t3, false);
  assert.equal('temps' in s.reports[1], false);
  s.stop(); assert.equal(collectorPids.size, 0); assert.equal(s.timers.size, 0);
});

test('malformed Usage and a throwing intake do not block the next report', async () => {
  const s = session(report => { if (report.cpu === 10) throw new Error('intake unavailable'); return 204; }); s.start();
  for (const value of ['not JSON', line(101), line(10), line(20)]) s.send(value);
  s.finishAll();
  await flush();
  assert.deepEqual(s.reports.map(r => r.cpu), [10, 20]);
  s.advance(44_999); assert.equal(s.reporters[0].kills, 0);
  s.stop();
});

test('rejected intake does not feed the watchdog', async () => {
  const s = session(() => 400); s.start(); s.advance(40_000);
  s.send(line()); s.finish(0); await flush();
  s.advance(5000); assert.equal(s.reporters[0].kills, 1);
  s.advance(1000); assert.equal(s.reporters.length, 2);
  s.stop();
});

test('crashes back off to a minute and accepted Usage resets the delay', async () => {
  const s = session(); s.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const count = s.reporters.length;
    s.reporters.at(-1)!.close();
    s.advance(delay - 1); assert.equal(s.reporters.length, count);
    s.advance(1); assert.equal(s.reporters.length, count + 1);
  }
  s.send(line()); s.finish(0); await flush();
  s.reporters.at(-1)!.close(); s.advance(999);
  const count = s.reporters.length;
  s.advance(1); assert.equal(s.reporters.length, count + 1);
  s.reporters.at(-1)!.close(); s.stop(); s.advance(60_000);
  assert.equal(s.reporters.length, count + 1); assert.equal(s.timers.size, 0);
});

test('watchdog restarts a hung reporter and ignores its pending probes', async () => {
  const s = session(); s.start(); s.send(line());
  s.advance(44_999); assert.equal(s.reporters[0].kills, 0);
  s.advance(1); assert.equal(s.reporters[0].kills, 1);
  s.advance(1000); assert.equal(s.reporters.length, 2);
  s.finish(0); await flush(); assert.equal(s.reports.length, 0);
  s.send(line(20)); s.finish(1); await flush(); assert.equal(s.reports[0].cpu, 20);
  s.stop();
});

test('stop during probes discards Usage and releases timers without a restart', async () => {
  const s = session(); s.start(); s.send(line());
  s.stop(); s.stop(); s.finish(0); await flush(); s.advance(120_000);
  assert.equal(s.reports.length, 0); assert.equal(s.reporters.length, 1);
  assert.equal(s.reporters[0].kills, 1); assert.equal(s.timers.size, 0);
});

test('unavailable reporter starts no processes or timers', () => {
  const s = session(); s.unavailable(); s.start(); s.stop();
  assert.equal(s.reporters.length, 0); assert.equal(s.timers.size, 0);
});

test('Windows CPU temperature is found by HWiNFO label despite holes, parsed in any culture, and omitted on failure', { skip: !existsSync(powershell) }, () => {
  for (const mode of ['holes', 'missing', 'other', 'junk', 'unlabelled']) {
    const source = `
${script.slice(0, script.indexOf('$cpu ='))}
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('de-DE')
function Get-ItemProperty {
  param([string]$Path, [string]$ErrorAction)
  if ('${mode}' -eq 'missing') { throw 'Cannot find path' }
  $props = [ordered]@{PSPath='registry'; Sensor0='Sensors'; Label0='Total CPU Usage'; ValueRaw0='7.3'; Sensor3='Ryzen'; Label3=$(if ('${mode}' -eq 'other') { 'GPU Temperature' } elseif ('${mode}' -eq 'unlabelled') { 'CPU' } else { 'CPU (Tctl/Tdie)' }); Value3='49,5'; ValueRaw3=$(if ('${mode}' -eq 'junk') { 'n/a' } else { '49.5' })}
  [pscustomobject]$props
}
$report = @{cpu=10}
${tempScript}
$report | ConvertTo-Json -Depth 4 -Compress`;
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    const report = JSON.parse(output.trim());
    if (mode === 'holes') assert.deepEqual(report.temps, { cpu: 49.5 });
    else assert.equal('temps' in report, false, mode);
  }
});

test('Windows VPN collection omits failures, prefers per-user duplicates and preserves UTF-8', { skip: !existsSync(powershell) }, () => {
  for (const failure of ['none', 'per-user', 'all-user', 'both']) {
    const source = `
${script.slice(0, script.indexOf('$cpu ='))}
function Get-VpnConnection {
  param([bool]$AllUserConnection, [string]$ErrorAction)
  if ('${failure}' -eq 'both' -or ('${failure}' -eq 'per-user' -and -not $AllUserConnection) -or ('${failure}' -eq 'all-user' -and $AllUserConnection)) { throw 'collection failed' }
  $status = if ($AllUserConnection) { 'Disconnected' } else { 'Connected' }
  [pscustomobject]@{Name='Escritório';ConnectionStatus=$status;TunnelType='L2tp'}
  if ($AllUserConnection) { [pscustomobject]@{Name='Other';ConnectionStatus='Disconnected';TunnelType='Ikev2'} }
}
$report = @{cpu=10;ram=@{used=1;total=2};disks=@()}
${vpnScript}
$report | ConvertTo-Json -Depth 4 -Compress`;
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
    const report = JSON.parse(output.trim());
    if (failure === 'none') assert.deepEqual(report.vpns, [
      { name: 'Escritório', status: 'connected', kind: 'ppp' },
      { name: 'Other', status: 'disconnected', kind: 'other' },
    ]);
    else assert.equal('vpns' in report, false, failure);
  }
});

test('Windows Process sample is bounded, uses executable names and resets CPU for new tokens', { skip: !existsSync(powershell) }, () => {
  const source = `
${script.slice(0, script.indexOf('$cpu ='))}
$logicalCpus = [Environment]::ProcessorCount
$collectorSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$previousProcesses = @{}
$processAt = [Diagnostics.Stopwatch]::GetTimestamp()
$report = @{}
${processScript}
$report | ConvertTo-Json -Depth 4 -Compress`;
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  const { processes } = JSON.parse(output.trim());
  assert.ok(processes.length > 0 && processes.length <= 400);
  for (const [index, proc] of processes.entries()) {
    assert.match(proc.name, /\.exe$/i);
    assert.equal(proc.app, proc.name.replace(/\.exe$/i, ''));
    assert.equal(proc.cpu, 0);
    assert.equal(typeof proc.started, 'string');
    if (!proc.started) assert.equal(proc.own, false);
    if (index) assert.ok(processes[index - 1].ram >= proc.ram);
  }
});

test('Windows process selection retains CPU leaders, strips controls and session zero never owns processes', { skip: !existsSync(powershell) }, () => {
  const source = `
${script.slice(0, script.indexOf('$cpu ='))}
function Get-Process {
  param([string]$ErrorAction)
  foreach ($id in 1..410) {
    $p = [pscustomobject]@{Id=$id; StartTime=[datetime]'2026-01-01'; SessionId=0; ProcessName=("café" + [char]9 + [char]1 + [char]133 + [char]159); TotalProcessorTime=[timespan]::FromSeconds($(if($id -eq 1){100}else{0})); WorkingSet64=$id}
    $p | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    $p
  }
}
$logicalCpus = 8
$collectorSession = 0
$previousProcesses = @{}
foreach ($id in 1..410) { $previousProcesses[([string]$id + ':' + ([datetime]'2026-01-01').Ticks)] = [double]0 }
$processAt = [Diagnostics.Stopwatch]::GetTimestamp() - [Diagnostics.Stopwatch]::Frequency
$report = @{}
${processScript}
$report | ConvertTo-Json -Depth 4 -Compress`;
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  const { processes } = JSON.parse(output.trim());
  assert.ok(processes.some((p: any) => p.pid === 1 && p.cpu > 0));
  assert.ok(processes.some((p: any) => p.pid === 410));
  assert.ok(processes.length <= 400);
  for (const p of processes) { assert.equal(p.own, false); assert.equal(p.name, 'café.exe'); }
});

test('Windows reporter emits its PID and logical CPU count before Usage', { skip: !existsSync(powershell) }, () => {
  const source = script.slice(0, script.indexOf('while ($true)'));
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000 });
  const header = JSON.parse(output.trim());
  assert.ok(Number.isSafeInteger(header.collectorPid) && header.collectorPid > 0);
  assert.ok(Number.isSafeInteger(header.logicalCpus) && header.logicalCpus > 0);
});
