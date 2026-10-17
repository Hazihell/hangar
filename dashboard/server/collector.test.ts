import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
import { reportFromLine, vpnScript, processScript, script } from './collector.ts';
test('PowerShell line maps Windows Usage and t3 status, skipping zero-size drives', () => {
  const line = '\uFEFF{"cpu":12.5,"ram":{"used":100,"total":200},"disks":[{"name":"C:","used":30,"total":100},{"name":"D:","used":0,"total":0}]}';
  assert.deepEqual(reportFromLine(line, 'pc', true), { machine: 'pc', cpu: 12.5, ram: { used: 100, total: 200 }, disks: [{ name: 'C:', used: 30, total: 100 }], services: { t3: true } });
  assert.equal(reportFromLine(line, 'pc', false).services.t3, false);
});
test('malformed collector lines and invalid Usage are rejected', () => {
  assert.throws(() => reportFromLine('not JSON', 'pc', false));
  assert.throws(() => reportFromLine('{"cpu":101,"ram":{"used":1,"total":2},"disks":[]}', 'pc', false), /invalid Usage/);
});

test('collector preserves OS-managed VPNs including status and internal kind', () => {
  const line = '{"cpu":10,"ram":{"used":1,"total":2},"disks":[],"vpns":[{"name":"Steeprock","status":"connected","kind":"ppp"}]}';
  assert.deepEqual(reportFromLine(line, 'pc', true).vpns, [{ name: 'Steeprock', status: 'connected', kind: 'ppp' }]);
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
    const report = reportFromLine(output.trim(), 'pc', true);
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
test('Windows collector header exposes its logical CPU count for WSL normalization', () => {
  assert.match(script, /logicalCpus=\$logicalCpus/);
});
