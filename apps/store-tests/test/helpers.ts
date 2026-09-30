import { env } from 'cloudflare:test';

/**
 * A stub for a store nothing else in the run has touched.
 *
 * Every test takes its store from here rather than naming one, because the plugin's
 * storage isolation does not reach SQLite-backed objects: a store written by one test is
 * still full in the next, whatever the config says (measured 2026-09-29). A random name
 * per call is the isolation, and it is a helper rather than a convention so a new test
 * cannot forget it.
 *
 * The name is what the object takes to be its user id, so it is also what its
 * `_meta.user_id` row will say.
 */
export function freshStore(label = 'test') {
  const userId = `${label}-${crypto.randomUUID()}`;
  return { userId, stub: env.USER_STORE.get(env.USER_STORE.idFromName(userId)) };
}
