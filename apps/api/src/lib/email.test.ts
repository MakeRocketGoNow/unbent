import { afterEach, describe, expect, it, vi } from 'vitest';
import { canSendEmail, sendEmail } from './email.js';

/**
 * The body posted to Resend, which is the part worth pinning: the field names are theirs,
 * not ours, and a rename here is silent — mail simply stops carrying the header, and
 * nothing fails.
 */
function captureRequest() {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return () => JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
}

const configured = {
  RESEND_API_KEY: 'test-key',
  EMAIL_FROM: 'Unbent <noreply@mail.example.com>',
};

const message = { to: 'someone@example.com', subject: 'Subject', text: 'Body' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canSendEmail', () => {
  it('needs both halves, since one alone cannot send anything', () => {
    expect(canSendEmail(configured)).toBe(true);
    expect(canSendEmail({ RESEND_API_KEY: 'k' })).toBe(false);
    expect(canSendEmail({ EMAIL_FROM: 'a@b.c' })).toBe(false);
    expect(canSendEmail({})).toBe(false);
  });

  /** A reply address alone does not make an instance able to send. */
  it('is not satisfied by a reply-to', () => {
    expect(canSendEmail({ EMAIL_REPLY_TO: 'hello@example.com' })).toBe(false);
  });
});

describe('sendEmail', () => {
  it('posts the fields Resend names', async () => {
    const body = captureRequest();
    await sendEmail(configured, message);
    expect(body()).toMatchObject({
      from: 'Unbent <noreply@mail.example.com>',
      to: 'someone@example.com',
      subject: 'Subject',
      text: 'Body',
    });
  });

  /**
   * Reply-To exists because the sending domain is usually a subdomain that is not a
   * mailbox: a From of noreply@mail.unbent.app is honest, and leaves anyone who presses
   * Reply talking to nothing.
   */
  it('carries a reply-to when one is configured', async () => {
    const body = captureRequest();
    await sendEmail({ ...configured, EMAIL_REPLY_TO: 'hello@example.com' }, message);
    expect(body().reply_to).toBe('hello@example.com');
  });

  /** Absent rather than empty: an empty header is not the same as no header. */
  it('omits the field entirely when none is configured', async () => {
    const body = captureRequest();
    await sendEmail(configured, message);
    expect('reply_to' in body()).toBe(false);
  });

  /** The HTML part rides beside the text, never in place of it. */
  it('carries an HTML part beside the text when there is one', async () => {
    const body = captureRequest();
    await sendEmail(configured, { ...message, html: '<p>Body</p>' });
    expect(body()).toMatchObject({ text: 'Body', html: '<p>Body</p>' });
  });

  it('sends text alone when there is no HTML part', async () => {
    const body = captureRequest();
    await sendEmail(configured, message);
    expect('html' in body()).toBe(false);
  });

  /**
   * The local path. Without a key the code or link is printed instead of sent, which is
   * what makes the flows testable offline — and what must never be reached deployed.
   */
  it('logs instead of sending when mail is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendEmail({}, message);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain('Body');
  });

  /** A refusal has to reach the caller, or a reset silently never arrives. */
  it('throws when Resend refuses the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('domain not verified', { status: 403 })),
    );
    await expect(sendEmail(configured, message)).rejects.toThrow(/403/);
  });

  /** The recipient is an email address, and does not belong in a thrown message. */
  it('keeps the recipient out of the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 422 })));
    await expect(sendEmail(configured, message)).rejects.not.toThrow(/someone@example\.com/);
  });
});
