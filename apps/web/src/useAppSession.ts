import { useEffect } from 'react';
import {
  answerFor,
  recordSession,
  sessionCheckAbandoned,
  useSession,
  type Session,
  type SessionState,
} from './auth-client.js';
import { rememberedSession } from './session-memory.js';

/**
 * `useSession`, read by the same rule as the route guard's `ensureSession`: a check that
 * could not reach the server leaves whoever was last signed in on this device signed in,
 * rather than sending them to `/login`. The signed-in chrome reads this, so a lost
 * connection and a session that has ended stop looking the same to it: the second still
 * arrives here, as a 401 or an answer with nobody in it, and still signs the page out.
 *
 * Its own module, beside `useSignOut`, because `auth-client.ts` is kept free of React
 * beyond what Better Auth itself exports; see `answerFor` there for the rule.
 */
export function useAppSession(): { session: Session | null; isPending: boolean; unreachable: boolean } {
  const state = useSession() as unknown as SessionState;
  const waiting = state.isPending && !sessionCheckAbandoned();
  useEffect(() => {
    if (waiting) return;
    answeredUnreachable = answerFor(state, rememberedSession()).unreachable;
    void recordSession(state);
    // `state` is a fresh object on every render; what it says is these three.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, state.data, state.error, state.isPending]);
  if (waiting) {
    const held = answeredUnreachable ? rememberedSession() : null;
    if (held) return { session: held, isPending: false, unreachable: true };
    return { session: null, isPending: true, unreachable: false };
  }
  return { ...answerFor(state, rememberedSession()), isPending: false };
}

/**
 * Whether the last answer read here was that the server could not be asked, so the page
 * is running on the remembered session.
 *
 * Better Auth holds its own answer through a check in flight: a store with a session in it
 * keeps `data` and says `isPending: false` until the server answers again. A remembered
 * session is ours, not the store's, and the store has nothing to hold, so when it is asked
 * again it reports `isPending: true`, which is exactly how the first check of a cold start
 * looks. That ask comes when the connection does (`installSessionRecheck`), and read as a
 * first check it sent every page that had been running offline back to the shell's
 * "Loading…" for the length of a round trip: the list, the search field and an open note's
 * editor were thrown away and drawn again from nothing (the offline gate's last check,
 * 2026-11-11). So a check in flight after that answer keeps it, the way the store keeps
 * its own, until the server says something.
 *
 * Only that answer is held. One with nobody in it has already sent the page to `/login`,
 * and a check that follows it is a sign-in, which must wait for the server as before.
 * Module-wide rather than per hook, so a component mounted during the check reads the
 * same answer as the shell around it; the remembered session it names is module-wide too.
 */
let answeredUnreachable = false;
