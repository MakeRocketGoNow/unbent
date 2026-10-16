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
    if (!waiting) void recordSession(state);
    // `state` is a fresh object on every render; what it says is these three.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, state.data, state.error, state.isPending]);
  if (waiting) return { session: null, isPending: true, unreachable: false };
  return { ...answerFor(state, rememberedSession()), isPending: false };
}
