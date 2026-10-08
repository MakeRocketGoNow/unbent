import { describe, expect, it } from 'vitest';
import { signInCodeEmail } from './sign-in-code-email.js';

describe('signInCodeEmail', () => {
  /**
   * Kept out of the subject on purpose: the message Gmail offered "Copy code" for had none
   * there. The notification still shows it, from the body's first line.
   */
  it('keeps the code out of the subject', () => {
    expect(signInCodeEmail('622468').subject).toBe('Your Unbent sign-in code');
  });

  /** The text part is what plain-text clients show and what the dev fallback prints. */
  it('keeps the code in the text part', () => {
    expect(signInCodeEmail('622468').text).toContain('Your Unbent sign-in code is 622468');
  });

  /**
   * The code alone in its own element, one unbroken run of digits, so a hand selection
   * copies it without gaps.
   */
  it('sets the code apart, unbroken, in the HTML part', () => {
    const { html } = signInCodeEmail('622468');
    expect(html).toMatch(/>622468<\/div>/);
    expect(html).toContain('Your Unbent sign-in code is');
  });

  /** Both parts carry the same fine print; one source keeps them in step. */
  it('says the same fine print in both parts', () => {
    const { text, html } = signInCodeEmail('622468');
    for (const line of ['Do not share it with anyone.', 'It expires in five minutes and can be used once.']) {
      expect(text).toContain(line);
      expect(html).toContain(line);
    }
  });

  it('never lets a code become markup', () => {
    const { html } = signInCodeEmail('<b>1</b>');
    expect(html).not.toContain('<b>1</b>');
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });
});
