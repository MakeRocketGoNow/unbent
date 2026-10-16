import { z } from 'zod';

/**
 * Jev, TypeSafe's "System One" model, over its one endpoint.
 *
 * Not a language model in the generating sense. It takes a piece of state and a set of
 * typed questions about it (pick one of these, is this true) and answers every question
 * at once with a probability per option. Nothing it says can fall outside the options it
 * was given, which is what makes it safe to wire straight into a note's filing: it cannot
 * invent a notebook, misspell a tag or hand a date field a sentence. What it cannot do is
 * write, so anything free-form (a title, a text field) is asked as a choice between
 * candidates the code found first; see lib/autofill.ts.
 *
 * One `fetch` against one endpoint, as lib/email.ts does with Resend, rather than the
 * `@typesafe-ai/sdk` package: that is Node-shaped and a few hundred kilobytes of bundle
 * for a POST with three fields, and a Worker pays its start-up on every cold request. The
 * request and answer shapes are those of https://docs.typesafe.ai/api.
 */

export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';

/** The alias TypeSafe's own SDKs default to. A pinned version would only go stale here. */
export const JEV_MODEL = 'jev-latest';

/** How long one call may take. Answers come in well under a second; this is for outages. */
const TIMEOUT_MS = 30_000;

/** Retried once, after a pause, on the two statuses the docs say to back off from. */
const RETRY_STATUSES = new Set([429, 529]);
const RETRY_AFTER_MS = 1000;

export interface JevEnv {
  /** `wrangler secret put TYPESAFE_API_KEY`; in dev it comes from .dev.vars. */
  TYPESAFE_API_KEY?: string;
  /** Where the requests go instead of TypeSafe, for a stand-in during development. */
  TYPESAFE_API_URL?: string;
}

/**
 * Whether this instance can ask Jev anything. The key alone decides: `/api/config`
 * reports it so the editor draws the control only where the route would answer.
 */
export function canAutofill(env: JevEnv): boolean {
  return Boolean(env.TYPESAFE_API_KEY?.trim());
}

/**
 * What the API takes wherever it takes text: a string, or JSON built from strings. The
 * docs recommend an object for state, so its parts are labelled, and objects for criteria
 * that need more than a sentence: `what`, `not_for`, `examples`.
 */
export type JevEntry = string | null | JevEntry[] | { [key: string]: JevEntry };

/** Pick one of the `criteria` keys. Answered with a probability per key. */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: JevEntry;
  criteria: Record<string, JevEntry>;
}

/** Is this true. Answered with one probability. */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: JevEntry;
  criteria?: { true?: JevEntry; false?: JevEntry };
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
  type: 'choice';
  /** The likeliest key. */
  choice: string;
  probabilities: Record<string, number>;
  /** How peaked the distribution is, 0 to 1: TypeSafe's own summary of `probabilities`. */
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  /** The probability that the statement is true. */
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

/** What a caller asks of Jev, so a test can hand in a stand-in. */
export interface Jev {
  ask(state: JevEntry, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>>;
}

/** The API refused or failed. `status` is HTTP's, or 0 when no answer arrived at all. */
export class JevError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

/*
   Answers are read by shape rather than by their `type` field, so a response that drops
   the field, or gains one, still reads. Nothing here needs the probabilities of a yes/no
   beyond the one number it carries.
*/
const choiceAnswer = z.object({
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const noulAnswer = z.object({ noul: z.number() });
const answersBody = z.object({ answers: z.record(z.string(), z.unknown()) });

function readAnswer(id: string, raw: unknown): JevAnswer {
  const choice = choiceAnswer.safeParse(raw);
  if (choice.success) return { type: 'choice', ...choice.data };
  const noul = noulAnswer.safeParse(raw);
  if (noul.success) return { type: 'noul', ...noul.data };
  throw new JevError(0, `Jev answered "${id}" in a shape this code does not read`);
}

/**
 * `model` is TypeSafe's alias unless the caller names another. Production never does; it
 * is there for the Auto-fill harness (apps/api/eval), which points this same client at
 * another System One endpoint (SubQ Snap) whose model has a name of its own, by way of
 * `TYPESAFE_API_URL` and this.
 */
export function jevFrom(env: JevEnv, fetchImpl: typeof fetch = fetch, model: string = JEV_MODEL): Jev {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error('Refusing to build a Jev client without a key');
  const url = env.TYPESAFE_API_URL?.trim() || JEV_API_URL;

  async function post(body: string): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new JevError(0, `Could not reach Jev: ${(err as Error).message}`);
    }
  }

  return {
    async ask(state, questions) {
      // Nothing to ask is a complete answer, not a request: the API would refuse an
      // empty map, and a caller with no questions should not pay for one.
      if (Object.keys(questions).length === 0) return {};

      const body = JSON.stringify({ state, model, questions });
      let res = await post(body);
      if (RETRY_STATUSES.has(res.status)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
        res = await post(body);
      }

      if (!res.ok) {
        // The body says why (an invalid key, a question the API could not read) and
        // the status alone does not. Truncated because this ends up in a log and on screen.
        const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
        throw new JevError(res.status, `Jev answered ${res.status}${detail ? `: ${detail}` : ''}`);
      }

      const parsed = answersBody.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new JevError(0, 'Jev answered with nothing this code can read');
      return Object.fromEntries(
        Object.entries(parsed.data.answers).map(([id, raw]) => [id, readAnswer(id, raw)]),
      );
    },
  };
}
