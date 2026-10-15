import { Hono } from 'hono';
import { INSTANCE_KINDS, type AppConfig, type InstanceKind } from '@unbent/shared';
import { accountDeletionOffered, getAuth, offeredProviders } from '../auth.js';
import { frontPageOf, legalLinksOf, operatorOf, posthogOf } from '../lib/instance.js';
import { whoAmI } from '../lib/session.js';
import { refuseGrantsWithoutAgreement } from './legal.js';
import { previewRelayOrigin } from '../lib/preview-relay.js';
import { canAutofill } from '../lib/jev.js';
import { billingOf } from '../lib/paddle.js';
import { registrationSummary, withoutEmptyMetadata } from '../lib/oauth-registration.js';
import type { AppEnv, Env } from '../types.js';

export const authRoutes = new Hono<AppEnv>()
  /**
   * Client registration, around Better Auth's handler; see `registerClient`. It has to
   * come before the catch-all below, which would otherwise answer it first.
   */
  .post('/auth/oauth2/register', (c) => registerClient(c.env, c.req.raw))
  /**
   * Better Auth owns everything under /api/auth — the OAuth start and callback URLs,
   * sign-out, and session endpoints. It receives the raw Request and returns a Response.
   * Two of them, the ones that grant a program a credential, first need the account to
   * have agreed to the terms; see `refuseGrantsWithoutAgreement`.
   */
  .all('/auth/*', refuseGrantsWithoutAgreement, (c) => getAuth(c.env).handler(c.req.raw))

  /** Who am I? Null when there is nobody, 503 when we could not tell — see `whoAmI`. */
  .get('/me', whoAmI)

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
   *
   * `frontPage` is the operator's again: on only where the instance says it is the public
   * one, since the page it turns on states that instance's prices. See `frontPageOf`.
   *
   * `backups` says whether a `BACKUPS` bucket is bound, so the privacy policy and the
   * deletion page describe the daily dumps only where they are made (MAK-171, part 7).
   *
   * `billing` is the same convention for the plan (MAK-108): present where the Worker has
   * the Paddle secrets, and the Plan tab and the trial banner are drawn on its presence
   * alone. It carries the client-side token, which is public by design — see `billingOf`.
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
      ownStores: c.env.PREVIEW_OWN_STORES === '1' || undefined,
      instanceLabel: instanceLabelOf(c.env),
      instanceKind: instanceKindOf(c.env),
      frontPage: frontPageOf(c.env),
      backups: c.env.BACKUPS ? true : undefined,
      billing: billingOf(c.env),
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

/** `INSTANCE_KIND` when it is one the page knows how to draw; see `AppConfig.instanceKind`. */
export function instanceKindOf(env: Pick<Env, 'INSTANCE_KIND'>): InstanceKind | undefined {
  const kind = env.INSTANCE_KIND?.trim().toLowerCase();
  return (INSTANCE_KINDS as readonly string[]).includes(kind ?? '') ? (kind as InstanceKind) : undefined;
}

/**
 * Dynamic client registration, with two things done around Better Auth's own (MAK-224).
 *
 * Metadata a client wrote out empty is taken out before Better Auth sees it, and a refusal
 * is logged with its reason; `withoutEmptyMetadata` and `registrationSummary` say why
 * each. Both are here, around the handler, rather than in the auth config's hooks, because
 * Better Auth checks a request's body against its schema before any hook runs: an empty
 * `contacts` was refused before a `before` hook could take it out, and an `after` hook
 * never heard of the refusal. The hook that registers loopback clients as native
 * (MAK-218) stays in the config; it reads only fields the schema has already accepted.
 *
 * A body that is not JSON goes through untouched, so the provider's own message for it
 * is the one the client gets.
 */
async function registerClient(env: Env, request: Request): Promise<Response> {
  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const trimmed = withoutEmptyMetadata(body);
  const sent = trimmed ?? body;
  // What was taken out, so a refusal still says whether empty metadata was part of it.
  const emptied = trimmed ? Object.keys(body as Record<string, unknown>).filter((k) => !(k in trimmed)) : [];
  const response = await getAuth(env).handler(
    new Request(request, { body: trimmed ? JSON.stringify(trimmed) : text }),
  );
  // A 429 is this server's own rate limit, not the provider judging the client; logging
  // those would be ten lines a minute from anyone who cared to send them.
  if (response.status >= 400 && response.status !== 429) {
    const answer = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown; error_description?: unknown; message?: unknown } | null;
    console.warn(
      '[oauth] registration refused',
      JSON.stringify({
        status: response.status,
        error: answer?.error,
        reason: answer?.error_description ?? answer?.message,
        request: registrationSummary(sent),
        emptied: emptied.length > 0 ? emptied.sort().slice(0, 40) : undefined,
      }),
    );
  }
  return response;
}
