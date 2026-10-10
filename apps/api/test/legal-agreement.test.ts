/**
 * Agreeing to the terms and privacy policy (MAK-209).
 *
 * What matters is what the session says afterwards, because that is what the app reads to
 * decide whether to ask: so this goes over HTTP, through sign-up, the agreement and a
 * read of the session, carrying the cookies the way a browser would. The session is served
 * from a signed cookie for five minutes, and a test that sent only the session token would
 * pass even if the agreement left that cookie saying the opposite.
 *
 * An instance that publishes no documents has nothing to agree to, and says so; which of
 * the two this suite checks depends on whether the dev server names an operator
 * (`OPERATOR_NAME` and `OPERATOR_EMAIL` in `.dev.vars`), and the cases it cannot check
 * are reported as skipped rather than passed.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

/** Cookies by name, replaced as a browser replaces them. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
  }
  has(name: string): boolean {
    return [...this.cookies.keys()].some((k) => k.endsWith(name));
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

let jar: Jar;
let legal: { version?: string } | undefined;

beforeAll(async () => {
  jar = new Jar();
  const email = `legal-${crypto.randomUUID()}@example.test`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery', name: 'Legal' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  jar.take(res);
  ({ legal } = (await (await fetch(`${BASE}/api/config`)).json()) as { legal?: { version?: string } });
});

function agree(version: unknown): Promise<Response> {
  return fetch(`${BASE}/api/legal/agree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: jar.header() },
    body: JSON.stringify({ version }),
  });
}

async function agreedVersion(): Promise<string | null | undefined> {
  const res = await fetch(`${BASE}/api/auth/get-session`, {
    headers: { Origin: ORIGIN, Cookie: jar.header() },
  });
  jar.take(res);
  const body = (await res.json()) as { user?: { legalVersion?: string | null } } | null;
  return body?.user?.legalVersion;
}

describe('POST /api/legal/agree', () => {
  it('refuses without a session', async () => {
    const res = await fetch(`${BASE}/api/legal/agree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ version: 'anything' }),
    });
    expect(res.status).toBe(401);
  });

  it('has nothing to agree to where no documents are published', async (ctx) => {
    if (legal?.version) return ctx.skip();
    expect((await agree('anything')).status).toBe(404);
  });

  it('records the agreement on the session, through the cached cookie', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    // The cookie cache is what has to be replaced; without it this proves less.
    expect(jar.has('session_data')).toBe(true);
    expect(await agreedVersion()).toBeNull();

    const res = await agree(legal.version);
    expect(res.status).toBe(200);
    jar.take(res);
    expect(await agreedVersion()).toBe(legal.version);
  });

  /** A second device pressing the same agreement records nothing new, and still lets it in. */
  it('agrees again to the same version without complaint', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    const res = await agree(legal.version);
    expect(res.status).toBe(200);
    jar.take(res);
    expect(await agreedVersion()).toBe(legal.version);
  });

  /** An app holding an older config must not record agreement to documents it never showed. */
  it('refuses a version this instance does not publish', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    const res = await agree('1999-01-01');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { version: string }).version).toBe(legal.version);
  });

  it('refuses a body with no version', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    expect((await agree(undefined)).status).toBe(400);
  });
});
