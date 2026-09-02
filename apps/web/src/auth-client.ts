import { createAuthClient } from 'better-auth/react';

/**
 * Same-origin in both dev (Vite proxy) and production (Pages routes /api to the Worker),
 * so the default baseURL of the current origin is correct and cookies travel normally.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
});

export const { signIn, signUp, signOut, useSession } = authClient;
