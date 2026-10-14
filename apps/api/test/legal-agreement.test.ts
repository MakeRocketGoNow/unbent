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

/** A fresh account that has agreed to nothing, signed in, with its cookies in a jar. */
async function signUp(): Promise<Jar> {
  const fresh = new Jar();
  const email = `legal-${crypto.randomUUID()}@example.test`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery', name: 'Legal' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  fresh.take(res);
  return fresh;
}

beforeAll(async () => {
  jar = await signUp();
  ({ legal } = (await (await fetch(`${BASE}/api/config`)).json()) as { legal?: { version?: string } });
});

function agree(version: unknown, as: Jar = jar): Promise<Response> {
  return fetch(`${BASE}/api/legal/agree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: as.header() },
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

/**
 * The two endpoints that give a program a credential of its own refuse an account that
 * has not agreed (`refuseGrantsWithoutAgreement`). The bodies name no real device code or
 * authorization, so past the check Better Auth refuses them for its own reasons. Before
 * agreeing, the refusal must be ours; after, it must be Better Auth's, and not its 404 — so
 * an upgrade that renamed either endpoint fails here rather than leaving it unguarded.
 */
describe('granting a credential before agreeing', () => {
  let fresh: Jar;
  beforeAll(async () => {
    fresh = await signUp();
  });

  async function answer(path: string, body: unknown): Promise<{ status: number; code?: string }> {
    const res = await fetch(`${BASE}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: fresh.header() },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { code?: string } | null;
    return { status: res.status, code: json?.code };
  }

  async function refusal(path: string, body: unknown): Promise<string | undefined> {
    const { status, code } = await answer(path, body);
    return status === 403 ? code : undefined;
  }

  it('refuses to approve a device or an app until the terms are agreed', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    expect(await refusal('device/approve', { userCode: 'ABCD-EFGH' })).toBe('TERMS_NOT_AGREED');
    expect(await refusal('oauth2/consent', { accept: true })).toBe('TERMS_NOT_AGREED');
  });

  /** Declining grants nothing, so there is nothing to agree to first. */
  it('lets an app be declined without agreeing', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    expect(await refusal('oauth2/consent', { accept: false })).not.toBe('TERMS_NOT_AGREED');
  });

  it('stops refusing once the terms are agreed', async (ctx) => {
    if (!legal?.version) return ctx.skip();
    const res = await agree(legal.version, fresh);
    expect(res.status).toBe(200);
    fresh.take(res);
    /*
     * Past the check, each path must still be Better Auth's own endpoint. The check runs
     * first and refuses by path, so it refuses a path Better Auth no longer serves just as
     * readily: only this side of it notices a rename, as the 404 Better Auth gives an
     * unknown path.
     */
    for (const [path, body] of [
      ['device/approve', { userCode: 'ABCD-EFGH' }],
      ['oauth2/consent', { accept: true }],
    ] as const) {
      const { status, code } = await answer(path, body);
      expect(code, path).not.toBe('TERMS_NOT_AGREED');
      expect(status, `${path} is no longer Better Auth's endpoint`).not.toBe(404);
    }
  });

  it('never refuses where no documents are published', async (ctx) => {
    if (legal?.version) return ctx.skip();
    expect(await refusal('device/approve', { userCode: 'ABCD-EFGH' })).not.toBe('TERMS_NOT_AGREED');
  });
});
