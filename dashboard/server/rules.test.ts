import { test } from 'node:test';
import assert from 'node:assert/strict';
import { online, minute } from './rules.ts';
test('Online ends exactly 30 seconds after arrival; unseen Machines are Offline', () => {
  assert.equal(online(1000, 30_999), true); assert.equal(online(1000, 31_000), false); assert.equal(online(null, 0), false);
});
test('minute buckets start on the minute', () => {
  assert.equal(minute(119_999), 60_000); assert.equal(minute(120_000), 120_000);
});
