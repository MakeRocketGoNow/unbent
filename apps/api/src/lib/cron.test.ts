import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cronJob } from './cron.js';

describe('cronJob', () => {
  it('runs the sweep at :17 and the dumps at :47, whatever the hour', () => {
    for (const hour of [0, 12, 23]) {
      expect(cronJob(Date.UTC(2026, 9, 5, hour, 17))).toBe('sweep');
      expect(cronJob(Date.UTC(2026, 9, 5, hour, 47))).toBe('dumps');
    }
  });

  // The two halves of one rule: the minutes the trigger fires on must land one in each.
  it('matches the trigger in wrangler.toml', () => {
    const toml = readFileSync(join(import.meta.dirname, '..', '..', 'wrangler.toml'), 'utf8');
    const cron = /^\[triggers\]\ncrons = \["([^"]+)"\]/m.exec(toml)?.[1];
    expect(cron).toBe('17,47 * * * *');
    const minutes = cron!.split(' ')[0]!.split(',').map(Number);
    expect(minutes.map((m) => cronJob(Date.UTC(2026, 9, 5, 3, m)))).toEqual(['sweep', 'dumps']);
  });
});
