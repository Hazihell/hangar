import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFromLine } from './collector.ts';
test('PowerShell line maps Windows Usage and t3 status, skipping zero-size drives', () => {
  const line = '\uFEFF{"cpu":12.5,"ram":{"used":100,"total":200},"disks":[{"name":"C:","used":30,"total":100},{"name":"D:","used":0,"total":0}]}';
  assert.deepEqual(reportFromLine(line, 'pc', true), { machine: 'pc', cpu: 12.5, ram: { used: 100, total: 200 }, disks: [{ name: 'C:', used: 30, total: 100 }], services: { t3: true } });
  assert.equal(reportFromLine(line, 'pc', false).services.t3, false);
});
test('malformed collector lines and invalid Usage are rejected', () => {
  assert.throws(() => reportFromLine('not JSON', 'pc', false));
  assert.throws(() => reportFromLine('{"cpu":101,"ram":{"used":1,"total":2},"disks":[]}', 'pc', false), /invalid Usage/);
});
