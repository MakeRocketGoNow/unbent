import { describe, it, expect, vi } from 'vitest';
import { returnTo, safeRedirect, shellFor } from './auth-gate.js';

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

  it('leaves the app WebView to the app', () => {
    expect(shellFor('/embed/notes/abc-123')).toBe('embed');
    expect(shellFor('/embed/index-files')).toBe('embed');
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
 * in it — a link in a mail, a page on another site. Sending a freshly authenticated
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
