import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ParsedLocation } from '@tanstack/react-router';
import { ensureSession } from './auth-client.js';
import { requireSession, returnTo, safeRedirect, shellFor } from './auth-gate.js';

// The gate imports the auth client for `ensureSession`; nothing below reaches the network,
// and creating a real client on import would point it at endpoints that are not there.
vi.mock('./auth-client.js', () => ({ ensureSession: vi.fn() }));

/**
 * Which paths render without a session.
 *
 * The list is short and every entry is on it for a reason that has already cost something:
 * gating the embed screens would draw a sign-in form inside the Android app's own chrome,
 * and gating the reset page made the link in the reset mail dead for the only people who
 * ever receive one.
 */
describe('shellFor', () => {
  it('gives the app shell to ordinary pages', () => {
    expect(shellFor('/notes')).toBe('app');
    expect(shellFor('/notes/abc-123')).toBe('app');
    expect(shellFor('/settings/notebooks')).toBe('app');
  });

  /**
   * The bare root is where a link to the site lands, so it must render for someone with no
   * session: the front page is for exactly them. Its route sends a signed-in visitor on to
   * the notes; the gate in front of everything else must not get there first.
   */
  it('gives the bare root a shell of its own, without a session', () => {
    expect(shellFor('/')).toBe('front');
  });

  /** The features page is read by someone with no account yet, like the story. */
  it('gives the features page the front page’s shell', () => {
    expect(shellFor('/features')).toBe('front');
    expect(shellFor('/features/')).toBe('front');
  });

  /** The comparisons are read by someone with no account yet, and only the listed ones are pages. */
  it('gives the comparisons the front page’s shell, and nothing else under their prefix', () => {
    expect(shellFor('/compare')).toBe('front');
    expect(shellFor('/compare/evernote')).toBe('front');
    expect(shellFor('/compare/joplin/')).toBe('front');
    expect(shellFor('/compare/onenote')).toBe('app');
  });

  it('lets the sign-in and reset pages render without a session', () => {
    expect(shellFor('/login')).toBe('plain');
    expect(shellFor('/reset-password')).toBe('plain');
  });

  /**
   * Both ends of the deletion mail. `/delete-account` has to be able to tell a browser
   * that it is not the signed-in one, which a redirect to the sign-in screen would replace
   * with a mystery; `/goodbye` can never have a session at all, since the account that
   * would have held it is gone by then. Gating either repeats the bug the reset page had.
   */
  it('lets both ends of the deletion mail render without a session', () => {
    expect(shellFor('/delete-account')).toBe('plain');
    expect(shellFor('/delete-account/')).toBe('plain');
    expect(shellFor('/goodbye')).toBe('plain');
    expect(shellFor('/goodbye/')).toBe('plain');
  });

  /**
   * The legal pages are read by people with no account, which is the whole point of them:
   * the Play listing links to the privacy policy, so it cannot sit behind a sign-in.
   */
  it('lets the legal pages render without a session', () => {
    expect(shellFor('/privacy')).toBe('plain');
    expect(shellFor('/terms')).toBe('plain');
    expect(shellFor('/privacy/')).toBe('plain');
  });

  /**
   * The pricing address a merchant of record's review follows is the front page in its own shell, and
   * ungated: the reviewer has no session, and gated it would be a sign-in screen where
   * they expected prices.
   */
  it('draws the pricing address as the front page, without a session', () => {
    expect(shellFor('/pricing')).toBe('front');
    expect(shellFor('/pricing/')).toBe('front');
  });

  /**
   * Pinned on its own rather than folded into the legal pages above, because the cost of
   * losing it is not a broken page: Play checks this URL from outside any session, and a
   * gated one answers 403 and fails review. That is the exact failure this route was added
   * for, the listing having pointed at `/settings/maintenance` before.
   */
  it('lets the account-deletion instructions render without a session', () => {
    expect(shellFor('/delete-my-account')).toBe('plain');
    expect(shellFor('/delete-my-account/')).toBe('plain');
  });

  it('leaves the app WebView to the app', () => {
    expect(shellFor('/embed/index-files')).toBe('embed');
  });

  /**
   * The token page the apps load before asking for a sign-in code: nobody is signed in
   * when it loads, and a redirect to the sign-in screen would be a web view nobody sees
   * waiting on a screen nobody can press.
   */
  it('lets the apps\' Turnstile page render without a session, and bare', () => {
    expect(shellFor('/turnstile')).toBe('embed');
    expect(shellFor('/turnstile/')).toBe('embed');
  });

  /** A hand-typed address may carry one, and it never means a different page. */
  it('ignores a trailing slash', () => {
    expect(shellFor('/login/')).toBe('plain');
    expect(shellFor('/privacy/')).toBe('plain');
  });

  /**
   * The default is what keeps this safe to add routes around: a new page is behind the
   * session unless somebody puts it on the list above.
   */
  it('gates a path it has never heard of', () => {
    expect(shellFor('/something-new')).toBe('app');
    // Not a prefix match: only pages actually under /embed/ skip the gate.
    expect(shellFor('/embedded')).toBe('app');
    expect(shellFor('/loginish')).toBe('app');
  });
});

/**
 * Where sign-in sends you afterwards.
 *
 * Both halves have been wrong in production. Returning always to `/notes` dropped the
 * device code and left the CLI waiting on a page the user could not get back to; returning
 * to the current URL unconditionally then parked people on a one-time approval page, which
 * shows an expiry error on the next visit and reads as sign-in being broken.
 */
describe('returnTo', () => {
  it('keeps a device code, so an approval survives signing in', () => {
    expect(returnTo('/device?user_code=ABCD1234')).toBe('/device?user_code=ABCD1234');
  });

  it('sends a bare /device to the notes, since there is nothing to approve', () => {
    expect(returnTo('/device')).toBe('/notes');
  });

  it('treats an empty user_code as no code', () => {
    expect(returnTo('/device?user_code=')).toBe('/notes');
  });

  it('keeps ordinary deep links intact', () => {
    expect(returnTo('/notes/abc-123')).toBe('/notes/abc-123');
    expect(returnTo('/trash')).toBe('/trash');
  });

  it('keeps query strings on ordinary pages', () => {
    expect(returnTo('/notes?tag=recipes')).toBe('/notes?tag=recipes');
  });

  it('leaves the root alone', () => {
    expect(returnTo('/')).toBe('/');
  });
});

/**
 * What the sign-in screen will follow.
 *
 * `?redirect=` is navigated to the moment someone signs in, and anything can put a value
 * in it: a link in a mail, a page on another site. Sending a freshly authenticated
 * browser to a host of the attacker's choosing is the classic shape of this bug.
 */
describe('safeRedirect', () => {
  it('accepts a path on this origin', () => {
    expect(safeRedirect('/notes')).toBe('/notes');
    expect(safeRedirect('/notes/abc-123?tag=recipes')).toBe('/notes/abc-123?tag=recipes');
    expect(safeRedirect('/device?user_code=ABCD1234')).toBe('/device?user_code=ABCD1234');
  });

  it('refuses another origin, however it is spelled', () => {
    expect(safeRedirect('https://evil.example/steal')).toBeUndefined();
    // Protocol-relative: a browser reads this as a host, not as a path.
    expect(safeRedirect('//evil.example')).toBeUndefined();
    // And so does this one, after normalising the backslash.
    expect(safeRedirect('/\\evil.example')).toBeUndefined();
    expect(safeRedirect('javascript:alert(1)')).toBeUndefined();
  });

  it('refuses anything that is not a path at all', () => {
    expect(safeRedirect('notes')).toBeUndefined();
    expect(safeRedirect('')).toBeUndefined();
    expect(safeRedirect(undefined)).toBeUndefined();
  });

  /** Signing in to arrive back at the sign-in screen is a loop looking for a reason. */
  it('refuses the sign-in screen itself', () => {
    expect(safeRedirect('/login')).toBeUndefined();
    expect(safeRedirect('/login/')).toBeUndefined();
    expect(safeRedirect('/login?redirect=/login')).toBeUndefined();
  });
});

/**
 * A gated page with no session, inside the Android app. The redirect still happens (the
 * page must not render a route it cannot load), but the app is told, because its own
 * sign-in screen is the one that offers the phone's account sheet. Outside the app nothing
 * is posted, since there is nothing to hear it.
 */
describe('requireSession inside the app', () => {
  const at = (href: string) => ({ pathname: href.split('?')[0], href }) as unknown as ParsedLocation;

  afterEach(() => {
    delete window.UnbentApp;
  });

  it('tells the app the session is gone, and still redirects', async () => {
    vi.mocked(ensureSession).mockResolvedValue(null);
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    await expect(requireSession(at('/notes/abc'))).rejects.toBeTruthy();
    expect(postMessage).toHaveBeenCalledWith('{"type":"unauthorized"}');
  });

  it('says nothing when there is a session', async () => {
    vi.mocked(ensureSession).mockResolvedValue({ user: { id: 'u1' } } as never);
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    await requireSession(at('/notes'));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('says nothing on a page that needs no session', async () => {
    vi.mocked(ensureSession).mockResolvedValue(null);
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    await requireSession(at('/login'));
    expect(postMessage).not.toHaveBeenCalled();
  });
});
