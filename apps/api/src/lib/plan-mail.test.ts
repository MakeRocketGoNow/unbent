import { describe, expect, it, vi } from 'vitest';
import { LAPSE_MAIL_PER_RUN, lapseKind, lapseMessage, notifyLapsedPlans } from './plan-mail.js';
import { RENEWAL_GRACE_MS } from './plan.js';

const stripe = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 's',
  STRIPE_PLAN_PRICE_ID: 'p',
  STRIPE_STORAGE_PRICE_ID: 'q',
  RESEND_API_KEY: 'k',
  EMAIL_FROM: 'Unbent <noreply@example.com>',
  APP_URL: 'https://notes.example.com/',
};

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
  it('says the notes are still there, whatever kind of plan ended', () => {
    for (const kind of ['trial', 'subscription', 'past_due', 'comp'] as const) {
      const { subject, text } = lapseMessage(kind, 'https://notes.example.com/settings/plan');
      expect(subject).toMatch(/ended|could not be collected/);
      expect(text).toContain('Your notes are still there');
      expect(text).toContain('read, search and export');
      expect(text).toContain('https://notes.example.com/settings/plan');
      expect(text).toContain('1 year');
    }
    expect(lapseMessage('trial', 'x').subject).toBe('Your Unbent trial has ended');
    // A failed renewal says to update the card, never to subscribe again.
    expect(lapseMessage('past_due', 'x').text).toContain('Update the card');
    expect(lapseMessage('past_due', 'x').text).not.toContain('Subscribe at');
  });

  it('tells a trial from a subscription from a comp by the row', () => {
    expect(lapseKind({ plan: 'trial', source: null })).toBe('trial');
    expect(lapseKind({ plan: 'active', source: 'stripe' })).toBe('subscription');
    expect(lapseKind({ plan: 'active', source: 'stripe', billing_status: 'past_due' })).toBe('past_due');
    expect(lapseKind({ plan: 'active', source: 'comp' })).toBe('comp');
  });

  it('sends nothing where billing or mail is off, and reads nothing', async () => {
    const { db, ran } = fakeDb([{ user_id: 'u', plan: 'trial', plan_until: 1, source: null, email: 'a@example.com' }]);
    expect(await notifyLapsedPlans({ ...stripe, RESEND_API_KEY: undefined, DB: db }, 10)).toEqual({ told: 0, subrequests: 0 });
    expect(await notifyLapsedPlans({ ...stripe, STRIPE_SECRET_KEY: undefined, DB: db }, 10)).toEqual({ told: 0, subrequests: 0 });
    expect(ran).toEqual([]);
  });

  it('mails each account that is due and marks it told; marks one the provider refuses too, and leaves one it could not reach for the next run', async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { to: string };
        sent.push(body.to);
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
    ]);
    // One told; the query, four sends and two marks spent.
    expect(await notifyLapsedPlans({ ...stripe, DB: db }, 10)).toEqual({ told: 1, subrequests: 7 });
    expect(sent).toEqual(['one@example.com', 'bad@example.com', 'down@example.com', 'slow@example.com']);
    // The due query with now, the limit and the renewal grace's cutoff, then a mark for
    // the one that went and the one refused for good; the provider's outage and its rate
    // limit are tried again next run.
    expect(ran[0]!.binds).toEqual([10, LAPSE_MAIL_PER_RUN, 10 - RENEWAL_GRACE_MS]);
    expect(ran.slice(1).map((r) => r.binds[0])).toEqual(['u1', 'u2']);
    expect(ran[1]!.sql).toContain('lapse_notified_at');
    vi.unstubAllGlobals();
  });
});
