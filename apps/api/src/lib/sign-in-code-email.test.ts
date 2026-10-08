import { describe, expect, it } from 'vitest';
import { signInCodeEmail } from './sign-in-code-email.js';

describe('signInCodeEmail', () => {
  /** The notification is often all anyone reads, so the code leads the subject. */
  it('puts the code at the front of the subject', () => {
    expect(signInCodeEmail('622468').subject).toBe('622468 is your Unbent sign-in code');
  });

  /** The text part is what plain-text clients show and what the dev fallback prints. */
  it('keeps the code in the text part', () => {
    expect(signInCodeEmail('622468').text).toContain('Your Unbent sign-in code is 622468');
  });

  /**
   * The point of the HTML part: the code alone in its own element, one unbroken run of
   * digits, so a client can find it and a hand selection copies it without gaps.
   */
  it('sets the code apart, unbroken, in the HTML part', () => {
    const { html } = signInCodeEmail('622468');
    expect(html).toMatch(/>622468<\/div>/);
    expect(html).toContain('Your Unbent sign-in code is');
  });

  /** Both parts say the same thing about expiry; one source keeps them in step. */
  it('says the same thing about expiry in both parts', () => {
    const { text, html } = signInCodeEmail('622468');
    const expiry = 'It expires in five minutes and can be used once.';
    expect(text).toContain(expiry);
    expect(html).toContain(expiry);
  });

  it('never lets a code become markup', () => {
    const { html } = signInCodeEmail('<b>1</b>');
    expect(html).not.toContain('<b>1</b>');
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });
});
