import { describe, expect, it } from 'vitest';
import { returnTo } from './Login.js';

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
