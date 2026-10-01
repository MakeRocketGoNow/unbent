import { describe, expect, it, vi } from 'vitest';
import { SWEEP_TOKEN_MIN_LENGTH, sweepTokenMatches } from './sweep-token.js';

const TOKEN = 'a'.repeat(SWEEP_TOKEN_MIN_LENGTH);

/**
 * The token is what lets a deploy job start the walk over every account with no session,
 * so the cases that matter are the ones where it must not: nothing configured, something
 * too short to be a secret, and anything but the exact value.
 */
describe('sweepTokenMatches', () => {
  it('accepts the configured token, ignoring the whitespace a secrets file can carry', async () => {
    expect(await sweepTokenMatches({ SWEEP_TOKEN: TOKEN }, TOKEN)).toBe(true);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: `${TOKEN}\n` }, ` ${TOKEN}`)).toBe(true);
  });

  it('refuses everything when no token is configured', async () => {
    expect(await sweepTokenMatches({}, TOKEN)).toBe(false);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: '' }, '')).toBe(false);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: '   ' }, '')).toBe(false);
  });

  it('refuses a wrong token, a prefix of the right one, and an empty one', async () => {
    expect(await sweepTokenMatches({ SWEEP_TOKEN: TOKEN }, 'b'.repeat(SWEEP_TOKEN_MIN_LENGTH))).toBe(false);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: TOKEN }, TOKEN.slice(0, -1))).toBe(false);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: TOKEN }, `${TOKEN}a`)).toBe(false);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: TOKEN }, '')).toBe(false);
  });

  it('ignores a configured token too short to be a secret, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const short = 'x'.repeat(SWEEP_TOKEN_MIN_LENGTH - 1);
    expect(await sweepTokenMatches({ SWEEP_TOKEN: short }, short)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
