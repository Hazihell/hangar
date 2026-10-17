import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
import { reportFromLine, gpuTemperature, vpnScript, tempScript, processScript, script } from './collector.ts';
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

test('collector merges the GPU temperature from nvidia-smi with the CPU one from Windows', () => {
  const line = '{"cpu":10,"ram":{"used":1,"total":2},"disks":[],"temps":{"cpu":49.5}}';
  assert.deepEqual(reportFromLine(line, 'pc', true, 38).temps, { cpu: 49.5, gpu: 38 });
  assert.deepEqual(reportFromLine(line, 'pc', true).temps, { cpu: 49.5 });
  assert.deepEqual(reportFromLine(line.replace(',"temps":{"cpu":49.5}', ''), 'pc', true, 38).temps, { gpu: 38 });
  assert.equal('temps' in reportFromLine(line.replace(',"temps":{"cpu":49.5}', ''), 'pc', true), false);
  assert.equal('temps' in reportFromLine(line.replace('{"cpu":49.5}', '{"cpu":1000}'), 'pc', true), false);
});
test('nvidia-smi output is the first GPU line or no temperature', () => {
  assert.equal(gpuTemperature('38\n'), 38);
  assert.equal(gpuTemperature('38\n41\n'), 38);
  assert.equal(gpuTemperature('41'), 41);
  for (const output of ['', '\n', 'N/A\n', '[N/A]', 'No devices were found\n', '38 C']) assert.equal(gpuTemperature(output), undefined, output);
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
