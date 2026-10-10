/**
 * The read-only rule for a lapsed account (MAK-108), over HTTP against a live
 * `wrangler dev`: once an account's plan has ended, every write but a delete is a 402,
 * and every read still answers. The rule is global (`requireActivePlan`), so this
 * checks a sample of each kind rather than every route; `plan-middleware.test.ts`
 * holds the whole table.
 *
 * Only where the dev server sells a plan: billing is off without the `PADDLE_*`
 * settings in `.dev.vars`, and then there is nothing to check, which the cases report
 * as skipped. The sandbox's values, or five made-up ones of the right shape, both turn
 * it on; nothing here reaches Paddle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

let cookie = '';
let billing = false;
let noteId = '';

async function signUp(): Promise<string> {
  const email = `plan-${crypto.randomUUID()}@example.test`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery', name: 'Plan' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0]!)
    .join('; ');
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function setPlan(plan: 'trial' | 'active' | 'inactive', until: number | null): Promise<void> {
  const res = await call('POST', '/api/admin/test/plan', { plan, until });
  if (!res.ok) throw new Error(`test plan failed: ${res.status} ${await res.text()}`);
}

beforeAll(async () => {
  cookie = await signUp();
  const config = (await (await fetch(`${BASE}/api/config`)).json()) as { billing?: unknown };
  billing = Boolean(config.billing);
  if (!billing) return;
  const made = await call('POST', '/api/notes', { title: 'Before the plan ended', body: 'still here' });
  noteId = ((await made.json()) as { id: string }).id;
});

afterAll(async () => {
  if (billing) await setPlan('trial', Date.now() + 86_400_000);
});

describe('a lapsed account', () => {
  it('starts on a trial, which the plan reports', async (ctx) => {
    if (!billing) return ctx.skip();
    const plan = (await (await call('GET', '/api/me/plan')).json()) as { state: string; until: number; storageGb: number };
    expect(plan.state).toBe('trial');
    expect(plan.until).toBeGreaterThan(Date.now());
    expect(plan.storageGb).toBe(10);
  });

  it('is refused every write but a delete once its plan has ended, and still reads', async (ctx) => {
    if (!billing) return ctx.skip();
    await setPlan('trial', Date.now() - 1000);
    expect(((await (await call('GET', '/api/me/plan')).json()) as { state: string }).state).toBe('inactive');

    const refused = await call('POST', '/api/notes', { title: 'x', body: 'y' });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { code: string }).code).toBe('PLAN_INACTIVE');
    expect((await call('PATCH', `/api/notes/${noteId}`, { title: 'renamed' })).status).toBe(402);
    expect((await call('POST', '/api/notebooks', { name: 'Later' })).status).toBe(402);

    expect((await call('GET', '/api/notes')).status).toBe(200);
    expect((await call('GET', `/api/notes/${noteId}`)).status).toBe(200);
    expect((await call('GET', '/api/search?q=here')).status).toBe(200);
    expect((await call('GET', '/api/export/notes')).status).toBe(200);
    expect((await call('GET', '/api/notes/' + noteId + '/export')).status).toBe(200);

    // The one write that is allowed, and its undo.
    expect((await call('DELETE', `/api/notes/${noteId}`)).ok).toBe(true);
    expect((await call('POST', `/api/notes/${noteId}/restore`)).ok).toBe(true);
    expect((await call('POST', '/api/billing/checkout', { storage: 0 })).status).not.toBe(402);
  });

  it('writes again once the plan is back', async (ctx) => {
    if (!billing) return ctx.skip();
    await setPlan('active', null);
    expect((await call('PATCH', `/api/notes/${noteId}`, { title: 'renamed' })).status).toBe(200);
    expect(((await (await call('GET', '/api/me/plan')).json()) as { state: string }).state).toBe('active');
  });
});
