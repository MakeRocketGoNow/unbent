import { describe, expect, it } from 'vitest';
import { parseHostTheme } from './embed.notes.$noteId.js';

describe('the host theme on the embed URL', () => {
  it('keeps a colour that is all digits, which the router would have read as a number', () => {
    expect(parseHostTheme('?surface=131313&onSurface=e5e2e1&outlineVariant=444746')).toEqual({
      surface: '131313',
      onSurface: 'e5e2e1',
      outlineVariant: '444746',
    });
  });

  it('keeps the hex forms JSON would have read as a number or refused', () => {
    expect(parseHostTheme('?surface=0e1234&onSurface=100e10&primary=001122')).toEqual({
      surface: '0e1234',
      onSurface: '100e10',
      primary: '001122',
    });
  });

  it('drops a bad value rather than refusing the page', () => {
    expect(parseHostTheme('?surface=%23131313&primary=red&error=ffb4ab&other=1')).toEqual({
      error: 'ffb4ab',
    });
  });

  it('is empty outside the app', () => {
    expect(parseHostTheme('')).toEqual({});
  });
});
