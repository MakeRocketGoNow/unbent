import { Hono } from 'hono';
import type { AppConfig } from '@unbent/shared';
import { accountDeletionOffered, getAuth, offeredProviders } from '../auth.js';
import { legalLinksOf, operatorOf, posthogOf } from '../lib/instance.js';
import { previewRelayOrigin } from '../lib/preview-relay.js';
import { canAutofill } from '../lib/jev.js';
import { canUseLlm } from '../lib/llm.js';
import type { AppEnv, Env } from '../types.js';

export const authRoutes = new Hono<AppEnv>()
  /**
   * Better Auth owns everything under /api/auth — the OAuth start and callback URLs,
   * sign-out, and session endpoints. It receives the raw Request and returns a Response.
   */
  .all('/auth/*', (c) => getAuth(c.env).handler(c.req.raw))

  /** Who am I? Returns null rather than 401 so the SPA can render a logged-out state. */
  .get('/me', (c) => c.json({ user: c.get('user') ?? null }))

  /**
   * What this instance offers. Public by necessity: a login screen has to know which
   * buttons to draw before there is a session. See `offeredProviders`.
   *
   * `accountDeletion` is here for the same reason the providers are — a control the server
   * would answer with a 404 should not be drawn. It is not a permission: the endpoint
   * enforces itself, and this only says whether asking it is worth the user's time.
   *
   * `operator` and `legal` are the same idea applied to the legal documents, which used to
   * be constants naming one company. A self-hosted instance that has not said who runs it
   * publishes no documents and draws no links to them — see lib/instance.ts.
   *
   * `previewRelay` is the same convention again: set only on a per-PR preview, where it
   * names the dev instance the login screen can borrow a Google session from — see
   * `previewRelayOrigin`. Absent everywhere else, and read as "no relay button".
   *
   * `autofill` is `accountDeletion`'s shape once more: true only where the instance has a
   * key for the model, so the editor draws the control only where the route would answer.
   * `vision` likewise: Maintenance runs the pass over images only where the server
   * has a reader for them.
   *
   * `satisfies` rather than a return annotation: the fields whose value is `undefined` are
   * dropped by `JSON.stringify` on the way out, which is exactly the "absent means not
   * offered" reading the client already applies to `accountDeletion`.
   */
  .get('/config', (c) => {
    const relayOrigin = previewRelayOrigin(c.env);
    return c.json({
      providers: offeredProviders(c.env),
      accountDeletion: accountDeletionOffered(c.env),
      operator: operatorOf(c.env),
      legal: legalLinksOf(c.env),
      posthog: posthogOf(c.env),
      previewRelay: relayOrigin ? { origin: relayOrigin } : undefined,
      autofill: canAutofill(c.env),
      vision: canUseLlm(c.env),
      ownStores: c.env.PREVIEW_OWN_STORES === '1' || undefined,
      instanceLabel: instanceLabelOf(c.env),
    } satisfies AppConfig);
  });

/**
 * `INSTANCE_LABEL`, trimmed and kept short. It goes in front of every tab title, where a
 * long one would push "Unbent" out of a narrow tab, so anything past a couple of words is
 * a mistake in the setting rather than something to show. Blank reads as unset.
 */
export function instanceLabelOf(env: Pick<Env, 'INSTANCE_LABEL'>): string | undefined {
  const label = env.INSTANCE_LABEL?.trim();
  return label ? label.slice(0, 24) : undefined;
}
