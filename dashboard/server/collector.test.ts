import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
import { reportFromLine, vpnScript, script } from './collector.ts';
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
