import { describe, expect, it, vi } from 'vitest';
import { lapseKind, lapseMessage, notifyLapsedPlans } from './plan-mail.js';

const paddle = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_x',
  PADDLE_WEBHOOK_SECRET: 's',
  PADDLE_CLIENT_TOKEN: 't',
  PADDLE_PLAN_PRICE_ID: 'p',
  PADDLE_STORAGE_PRICE_ID: 'q',
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
    for (const kind of ['trial', 'subscription', 'comp'] as const) {
      const { subject, text } = lapseMessage(kind, 'https://notes.example.com/settings/plan');
      expect(subject).toContain('ended');
      expect(text).toContain('Your notes are still there');
      expect(text).toContain('read, search and export');
      expect(text).toContain('https://notes.example.com/settings/plan');
      expect(text).toContain('1 year');
    }
    expect(lapseMessage('trial', 'x').subject).toBe('Your Unbent trial has ended');
  });

  it('tells a trial from a subscription from a comp by the row', () => {
    expect(lapseKind({ plan: 'trial', source: null })).toBe('trial');
    expect(lapseKind({ plan: 'active', source: 'paddle' })).toBe('subscription');
    expect(lapseKind({ plan: 'active', source: 'comp' })).toBe('comp');
  });

  it('sends nothing where billing or mail is off, and reads nothing', async () => {
    const { db, ran } = fakeDb([{ user_id: 'u', plan: 'trial', plan_until: 1, source: null, email: 'a@example.com' }]);
    expect(await notifyLapsedPlans({ ...paddle, RESEND_API_KEY: undefined, DB: db }, 10)).toBe(0);
    expect(await notifyLapsedPlans({ ...paddle, PADDLE_API_KEY: undefined, DB: db }, 10)).toBe(0);
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
        return new Response('{}', { status: 200 });
      }),
    );
    const { db, ran } = fakeDb([
      { user_id: 'u1', plan: 'trial', plan_until: 1, source: null, email: 'one@example.com' },
      { user_id: 'u2', plan: 'active', plan_until: 1, source: 'paddle', email: 'bad@example.com' },
      { user_id: 'u3', plan: 'active', plan_until: 1, source: 'comp', email: 'down@example.com' },
    ]);
    expect(await notifyLapsedPlans({ ...paddle, DB: db }, 10)).toBe(1);
    expect(sent).toEqual(['one@example.com', 'bad@example.com', 'down@example.com']);
    // The due query with now and the limit, then a mark for the one that went and the
    // one refused for good; the provider's outage is tried again next run.
    expect(ran[0]!.binds).toEqual([10, 5]);
    expect(ran.slice(1).map((r) => r.binds[0])).toEqual(['u1', 'u2']);
    expect(ran[1]!.sql).toContain('lapse_notified_at');
    vi.unstubAllGlobals();
  });
});
