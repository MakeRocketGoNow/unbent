import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyTally, summaryLines } from './restore-summary.mjs';

test('reads the last tally out of an rclone JSON log, and nulls out of none', () => {
  const log = [
    'not json',
    JSON.stringify({ level: 'info', msg: 'Copied (new)', object: 'users/u/n/scan.pdf' }),
    JSON.stringify({ level: 'info', msg: 'stats', stats: { transfers: 1, bytes: 10, checks: 0, errors: 0 } }),
    JSON.stringify({ level: 'info', msg: 'stats', stats: { transfers: 3, bytes: 300, checks: 2, errors: 1 } }),
    '',
  ].join('\n');
  assert.deepEqual(copyTally(log), { copied: 3, bytes: 300, skipped: 2, errors: 1 });
  assert.deepEqual(copyTally(''), { copied: null, bytes: null, skipped: null, errors: null });
});

test('says what a run did, or would do, in counts and never in names', () => {
  const done = summaryLines({ account: 'u1', mirrored: 5, dryRun: false }, { copied: 3, bytes: 300, skipped: 2, errors: 0 }).join('\n');
  assert.match(done, /^## Restored files of account u1/);
  assert.match(done, /Copied: 3 file\(s\), 300 bytes/);
  assert.match(done, /left alone: 2/);
  assert.match(done, /Nothing was deleted or overwritten/);
  const dry = summaryLines({ account: 'u1', mirrored: null, dryRun: true }, { copied: null, bytes: null, skipped: null, errors: null }).join('\n');
  assert.match(dry, /^## Would restore/);
  assert.match(dry, /In the mirror: \? file/);
  assert.match(dry, /Dispatch again with `confirm`/);
});
