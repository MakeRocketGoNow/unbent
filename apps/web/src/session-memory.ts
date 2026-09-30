/**
 * Who was last signed in on this device, kept so that losing the connection is not
 * mistaken for signing out.
 *
 * The session check is a request. With no signal it fails, and the app used to read that
 * failure exactly as it read "nobody is signed in": it sent the page to `/login` and told
 * the Android app `unauthorized` — so the one moment someone opened the installed app to
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

/**
 * A sign-out the server has not heard yet: the id of the session to end.
 *
 * Signing out with no connection can only be half done. What this device holds — who it
 * remembers, the notes kept for reading offline — is cleared on the spot, but in a browser
 * the session cookie is HttpOnly and only the server can end it. Left like that, the next
 * page load online would find the cookie still good and sign the person straight back in.
 * So the session's id is kept here, and `ensureSession` ends it the next time it can ask
 * the server. By id, not as a yes/no flag: a new sign-in in the meantime — a Google
 * redirect included — is a different session, and must not be ended on arrival.
 */
const SIGN_OUT_KEY = 'unbent.sign-out-pending';

export function markSignOutPending(sessionId: string): void {
  try {
    localStorage.setItem(SIGN_OUT_KEY, sessionId);
  } catch {
    // Storage refused: the sign-out stays local, which is all it could be offline anyway.
  }
}

export function pendingSignOut(): string | null {
  try {
    return localStorage.getItem(SIGN_OUT_KEY);
  } catch {
    return null;
  }
}

export function clearSignOutPending(): void {
  try {
    localStorage.removeItem(SIGN_OUT_KEY);
  } catch {
    // Nothing was stored, or nothing can be.
  }
}
