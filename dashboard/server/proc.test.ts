import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcCollector, readProc, type Proc } from './proc.ts';

test('proc uses comm and statm while parsing stat names with parentheses', () => {
  const fields = Array(22).fill('0'); fields[0] = 'S'; fields[1] = '7'; fields[11] = '120'; fields[12] = '30'; fields[19] = '12345'; fields[21] = '9';
  assert.deepEqual(readProc(42, path => {
    if (path.endsWith('/stat')) return `42 (worker (busy)) ${fields.join(' ')}`;
    if (path.endsWith('/comm')) return 'comm worker\n';
    if (path.endsWith('/statm')) return '100 11 0 0 0 0 0\n';
    return 'Uid:\t1000\t1000\t1000\t1000\n';
  }), {
    pid: 42, name: 'comm worker', started: '12345', uid: 1000, ppid: 7, ticks: 150, ram: 45056,
  });
});
test('CPU uses interval ticks across all cores, resets reused PIDs and skips vanished processes', () => {
  let time = 0;
  const proc: Proc = { pid: 42, name: 'node', started: 'a', uid: 1000, ppid: 1, ticks: 100, ram: 1000 };
  const sample = createProcCollector({ list: () => ['42', '43', 'self'], read: pid => { if (pid === 43) throw Error('gone'); return proc; }, now: () => time, cpus: 4, uid: 1000 });
  assert.equal(sample()[0].cpu, 0);
  time = 1000; proc.ticks += 200;
  assert.deepEqual(sample()[0], { pid: 42, name: 'node', app: 'node', started: 'a', own: true, cpu: 50, ram: 1000 });
  time = 2000; proc.started = 'b'; proc.uid = 0;
  assert.equal(sample()[0].cpu, 0); assert.equal(sample()[0].own, false);
});
test('keeps the union of RAM and CPU leaders and propagates listing failure', () => {
  const sample = createProcCollector({ list: () => Array.from({ length: 410 }, (_, n) => String(n + 1)), read: pid => ({ pid, name: 'x', started: '1', uid: 0, ppid: 1, ticks: 0, ram: pid }) });
  const result = sample(); assert.equal(result.length, 300); assert.equal(result[0].pid, 410); assert.equal(result.at(-1)?.pid, 111);
  assert.throws(createProcCollector({ list: () => { throw Error('unreadable'); } }), /unreadable/);
});
test('retains low-memory CPU leaders and uses changing host CPU count with sanitized names', () => {
  let time = 0, cores = 8;
  const sample = createProcCollector({ list: () => Array.from({length: 410}, (_, i) => String(i + 1)), now: () => time, cpus: () => cores,
    read: pid => ({ pid, name: 'café\t\u0001\u0085\u009f', started: '1', uid: 0, ppid: 1, ticks: pid === 1 ? time / 10 : 0, ram: pid }) });
  sample(); time = 1000;
  const result = sample();
  assert.equal(result.find(p => p.pid === 1)?.cpu, 12.5);
  assert.equal(result.find(p => p.pid === 1)?.name, 'café');
  assert.ok(result.some(p => p.pid === 410));
  cores = 4; time = 2000;
  assert.equal(sample().find(p => p.pid === 1)?.cpu, 25);
});
