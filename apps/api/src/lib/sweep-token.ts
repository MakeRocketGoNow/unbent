import type { Env } from '../types.js';

/**
 * The header a deploy job sends `SWEEP_TOKEN` in, to start the note-store sweep without a
 * session.
 *
 * A header of its own rather than `Authorization: Bearer`, which Better Auth's bearer
 * plugin already claims: every request's session lookup would read the token as a session
 * token and query D1 for it, and a token in the one header both paths read is a token
 * whose meaning depends on which path got to it first.
 */
export const SWEEP_TOKEN_HEADER = 'X-Unbent-Sweep-Token';

/**
 * Shorter than this and a configured token is ignored, with a line in the log. The route
 * it opens walks every account and costs subrequests and rows read on each call, so a
 * guessable value is worse than none; `openssl rand -hex 32` gives sixty-four characters.
 */
export const SWEEP_TOKEN_MIN_LENGTH = 32;

/**
 * Whether `presented` is this deployment's sweep token.
 *
 * False when none is configured, which is every instance until its operator sets one, so
 * the route stays operator-session-only by default. Compared as SHA-256 digests, byte by
 * byte to the end: the digests are the same length whatever was sent, and a comparison
 * that stopped at the first wrong byte would time how much of the token a caller had
 * guessed. Digests rather than the runtime's `timingSafeEqual` because the unit tests run
 * under Node, where `crypto.subtle` has no such method.
 */
export async function sweepTokenMatches(env: Pick<Env, 'SWEEP_TOKEN'>, presented: string): Promise<boolean> {
  const expected = env.SWEEP_TOKEN?.trim();
  if (!expected) return false;
  if (expected.length < SWEEP_TOKEN_MIN_LENGTH) {
    console.warn(`[store] SWEEP_TOKEN is shorter than ${SWEEP_TOKEN_MIN_LENGTH} characters and is ignored`);
    return false;
  }
  const [a, b] = await Promise.all([digest(expected), digest(presented.trim())]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
