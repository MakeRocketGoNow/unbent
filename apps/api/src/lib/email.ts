/**
 * Sending mail from a Worker.
 *
 * There is no SMTP here: Workers have no raw sockets, so nodemailer and everything built
 * on it are out. What is left is an HTTP API, and Resend is the one Cloudflare's own
 * MailChannels notice now points at. Its free tier is 3,000 a month and 100 a day, which
 * for password resets on an instance with an allowlist is more headroom than this will
 * ever need.
 *
 * One `fetch` against one endpoint, so no SDK: a dependency here would be several hundred
 * kilobytes of bundle for a POST with three fields, and the Worker's start-up time is
 * charged on every cold request.
 */

/** What sending needs from the environment. Both absent means mail is simply not configured. */
export interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export interface Message {
  to: string;
  subject: string;
  text: string;
}

/**
 * Whether this instance can send mail at all.
 *
 * Mirrors how `offeredProviders` treats OAuth credentials: a half-configured provider is
 * treated as absent rather than as a failure waiting to happen at the moment someone
 * presses a button. Callers use this to decide whether to offer a reset link, so that a
 * self-hosted instance without mail does not advertise a flow that cannot finish.
 */
export function canSendEmail(env: EmailEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

/**
 * Sends one message, or logs it when mail is not configured.
 *
 * The dev fallback is deliberate and load-bearing: a local instance has no Resend key, and
 * a password reset that threw there would make the flow untestable without signing up for
 * an account and putting a real key in .dev.vars. Printing the link instead means the whole
 * path — request, token, redemption — can be exercised offline, which is how it gets
 * tested. It logs the body, so it must never be reached in production; `canSendEmail`
 * gates the feature so a deployed instance either has mail or does not offer the flow.
 */
export async function sendEmail(env: EmailEnv, message: Message): Promise<void> {
  if (!canSendEmail(env)) {
    console.log(`[email] not configured; would have sent to ${message.to}:\n${message.text}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!res.ok) {
    /**
     * Read the body for the reason — Resend explains itself there (an unverified sending
     * domain, a malformed address) and the status alone does not. Truncated because this
     * ends up in `wrangler tail`, and the recipient is deliberately left out of the thrown
     * message: it is an email address, and the caller already knows who it was sending to.
     */
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend rejected the message: ${res.status} ${detail.slice(0, 200)}`);
  }
}
