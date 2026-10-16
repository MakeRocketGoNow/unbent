/**
 * Who was last signed in on this device, kept so that losing the connection is not
 * mistaken for signing out.
 *
 * The session check is a request. With no signal it fails, and the app used to read that
 * failure exactly as it read "nobody is signed in": it sent the page to `/login` and told
 * the Android app `unauthorized`, so the one moment someone opened the installed app to
 * read a note they had already opened was the moment it threw them out. The server can
 * say which it is (a 401, or a session answer with nobody in it); a request that never
 * arrived cannot. When it cannot, the app carries on as whoever this remembers, and the
 * next answer the server does give settles it.
 *
 * Only what the chrome shows and the query cache is keyed on: the id, the address and
 * the name. It is forgotten on every answer that says nobody is signed in, and on signing
 * out, so it never outlives the session it describes by more than the time it takes the
 * server to be asked. Under the `unbent.` prefix `usePersistentState` uses, and wrapped
 * like it: a browser that refuses storage just has nothing to fall back on, which is how
 * the app behaved before this existed.
 */

export interface RememberedSession {
  user: { id: string; email: string; name?: string };
}

const KEY = 'unbent.session';

export function rememberSession(user: { id: string; email: string; name?: string | null }): void {
  try {
    const value: RememberedSession = {
      user: { id: user.id, email: user.email, ...(user.name ? { name: user.name } : {}) },
    };
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage refused or full. Offline, this device then behaves as it did before.
  }
}

export function rememberedSession(): RememberedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedSession>;
    const user = parsed.user;
    if (typeof user?.id !== 'string' || typeof user.email !== 'string') return null;
    return { user: { id: user.id, email: user.email, ...(typeof user.name === 'string' ? { name: user.name } : {}) } };
  } catch {
    return null;
  }
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing was stored, or nothing can be.
  }
}
