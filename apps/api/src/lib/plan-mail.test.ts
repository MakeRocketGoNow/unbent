import { describe, expect, it, vi } from 'vitest';
import { LAPSE_MAIL_PER_RUN, LAPSE_UNREAD_DEFER_MS, lapseKind, lapseMessage, notifyLapsedPlans } from './plan-mail.js';
import { RENEWAL_GRACE_MS } from './plan.js';
import type { Env } from '../types.js';

const stripe = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 's',
  STRIPE_PLAN_PRICE_ID: 'p',
  STRIPE_STORAGE_PRICE_ID: 'q',
  RESEND_API_KEY: 'k',
  EMAIL_FROM: 'Unbent <noreply@example.com>',
  APP_URL: 'https://notes.example.com/',
};

/** Each account's store, answering what it holds; one named `gone` cannot be reached. */
function fakeStores(held: Record<string, { notes: number; attachmentBytes: number }>) {
  return {
    USER_STORE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        usage: async () => {
          if (!held[name]) throw new Error('Network connection lost.');
          return { databaseSize: 1, lastWriteAt: null, wiped: false, ...held[name] };
        },
      }),
    },
  } as unknown as Pick<Env, 'USER_STORE'>;
}

const small = { notes: 40, attachmentBytes: 200 * 1024 * 1024 };
const big = { notes: 1000, attachmentBytes: 0 };

/** A D1 that answers the due query with `rows` and records every statement run. */
function fakeDb(rows: unknown[]) {
  const ran: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        all: async () => {
          ran.push({ sql, binds });
          return { results: rows };
        },
        run: async () => {
          ran.push({ sql, binds });
          return {};
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, ran };
}

describe('the lapse mail', () => {
  it('says the notes are still there, whatever kind of plan ended, to an account past the free plan', () => {
    for (const kind of ['trial', 'subscription', 'past_due', 'comp'] as const) {
      const { subject, text } = lapseMessage(kind, 'https://notes.example.com/settings/plan', big);
      expect(subject).toMatch(/ended|could not be collected/);
      expect(text).toContain("This account holds 1,000 notes, more than the free plan's 100, so it is now read-only.");
      expect(text).toContain('Your notes are still there');
      expect(text).toContain('read, search and export');
      expect(text).toContain('https://notes.example.com/settings/plan');
      expect(text).toContain('delete down to 100 notes and 1 GB of files');
      expect(text).toContain('1 year');
    }
    expect(lapseMessage('trial', 'x', big).subject).toBe('Your Unbent trial has ended');
    // A failed renewal says to update the card, never to subscribe again.
    expect(lapseMessage('past_due', 'x', big).text).toContain('Update the card');
    expect(lapseMessage('past_due', 'x', big).text).not.toContain('Subscribe at');
  });

  it('tells an account within the free plan that it carries on as a free account, with its own numbers', () => {
    for (const kind of ['trial', 'subscription', 'past_due', 'comp'] as const) {
      const { text } = lapseMessage(kind, 'https://notes.example.com/settings/plan', small);
      expect(text).toContain("This account holds 40 notes and 200 MB of files, within the free plan's 100 notes and 1 GB, so it carries on as a free account");
      expect(text).not.toContain('read-only');
      expect(text).toContain('https://notes.example.com/settings/plan');
    }
    expect(lapseMessage('trial', 'x', small).text).toContain('Subscribe at x for unlimited notes, 10 GB of files and more Auto-fill.');
    expect(lapseMessage('subscription', 'x', small).text).toContain('Subscribe again at x');
    expect(lapseMessage('past_due', 'x', small).text).toContain('Update the card from x');
  });

  it('tells a trial from a subscription from a comp by the row', () => {
    expect(lapseKind({ plan: 'trial', source: null })).toBe('trial');
    expect(lapseKind({ plan: 'active', source: 'stripe' })).toBe('subscription');
    expect(lapseKind({ plan: 'active', source: 'stripe', billing_status: 'past_due' })).toBe('past_due');
    expect(lapseKind({ plan: 'active', source: 'comp' })).toBe('comp');
  });

  it('sends nothing where billing or mail is off, and reads nothing', async () => {
    const { db, ran } = fakeDb([{ user_id: 'u', plan: 'trial', plan_until: 1, source: null, email: 'a@example.com' }]);
    const stores = fakeStores({ u: small });
    expect(await notifyLapsedPlans({ ...stripe, ...stores, RESEND_API_KEY: undefined, DB: db }, 10)).toEqual({ told: 0, subrequests: 0 });
    expect(await notifyLapsedPlans({ ...stripe, ...stores, STRIPE_SECRET_KEY: undefined, DB: db }, 10)).toEqual({ told: 0, subrequests: 0 });
    expect(ran).toEqual([]);
  });

  it('mails each account that is due and marks it told; marks one the provider refuses too, and leaves one it could not reach for the next run', async () => {
    const sent: string[] = [];
    const texts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { to: string; text: string };
        sent.push(body.to);
        texts.push(body.text);
        if (body.to === 'bad@example.com') return new Response('nope', { status: 422 });
        if (body.to === 'down@example.com') return new Response('later', { status: 503 });
        if (body.to === 'slow@example.com') return new Response('too many', { status: 429 });
        return new Response('{}', { status: 200 });
      }),
    );
    const { db, ran } = fakeDb([
      { user_id: 'u1', plan: 'trial', plan_until: 1, source: null, email: 'one@example.com' },
      { user_id: 'u2', plan: 'active', plan_until: 1, source: 'stripe', email: 'bad@example.com' },
      { user_id: 'u3', plan: 'active', plan_until: 1, source: 'comp', email: 'down@example.com' },
      { user_id: 'u4', plan: 'active', plan_until: 1, source: 'stripe', email: 'slow@example.com' },
      { user_id: 'gone', plan: 'trial', plan_until: 1, source: null, email: 'unread@example.com' },
    ]);
    const stores = fakeStores({ u1: small, u2: big, u3: small, u4: big });
    // One told; the query, five store reads (one failing), four sends and two marks spent.
    expect(await notifyLapsedPlans({ ...stripe, ...stores, DB: db }, 10)).toEqual({ told: 1, subrequests: 12 });
    // The one whose store could not say is not mailed, and is tried again next run.
    expect(sent).toEqual(['one@example.com', 'bad@example.com', 'down@example.com', 'slow@example.com']);
    expect(texts[0]).toContain('carries on as a free account');
    expect(texts[1]).toContain('now read-only');
    // The due query with now, the limit and the renewal grace's cutoff, then a mark for
    // the one that went and the one refused for good; the provider's outage and its rate
    // limit are tried again next run.
    expect(ran[0]!.binds).toEqual([10, LAPSE_MAIL_PER_RUN, 10 - RENEWAL_GRACE_MS]);
    expect(ran.slice(1).map((r) => r.binds[0])).toEqual(['u1', 'u2']);
    expect(ran[1]!.sql).toContain('lapse_notified_at');
    vi.unstubAllGlobals();
  });

  it('defers an account whose store will not answer for a day, then tells it both outcomes and marks it', async () => {
    const texts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        texts.push((JSON.parse(init.body as string) as { text: string }).text);
        return new Response('{}', { status: 200 });
      }),
    );
    const day = LAPSE_UNREAD_DEFER_MS;
    const fresh = fakeDb([{ user_id: 'gone', plan: 'trial', plan_until: 10 * day, source: null, email: 'a@example.com' }]);
    expect(await notifyLapsedPlans({ ...stripe, ...fakeStores({}), DB: fresh.db }, 10 * day + 1000)).toEqual({ told: 0, subrequests: 2 });
    expect(fresh.ran).toHaveLength(1);
    // A day after it could first be due (its end and the renewal's grace) it still waits.
    const renewing = fakeDb([{ user_id: 'gone', plan: 'active', plan_until: 10 * day, source: 'stripe', billing_status: 'active', email: 'a@example.com' }]);
    expect(await notifyLapsedPlans({ ...stripe, ...fakeStores({}), DB: renewing.db }, 11 * day + 1000)).toEqual({ told: 0, subrequests: 2 });
    // A trial is due at its end, so its day is counted from there.
    const stale = fakeDb([{ user_id: 'gone', plan: 'trial', plan_until: 10 * day, source: null, email: 'a@example.com' }]);
    expect(await notifyLapsedPlans({ ...stripe, ...fakeStores({}), DB: stale.db }, 11 * day + 1000)).toEqual({ told: 1, subrequests: 4 });
    expect(stale.ran[1]!.sql).toContain('lapse_notified_at');
    expect(texts[0]).toContain('An account that holds up to 100 notes, counting the trash, and 1 GB of files carries on as a free account');
    expect(texts[0]).toContain('the Plan page there says which this account is');
    vi.unstubAllGlobals();
  });
});
