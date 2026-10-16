/**
 * The email that carries a sign-in code.
 *
 * Plain text was enough to deliver the code, but not for a mail client to recognise it.
 * Gmail offers a "Copy code" card on messages it decides hold a one-time code, and it
 * decides on its own: there is no header, markup or registration a sender can use to ask
 * for it. So this copies the shape of a message that gets it, compared header by header
 * against one that did: an HTML part, a subject with no code in it, and the warning not
 * to share the code that nearly every code email carries. That message had its code in
 * bold mid-sentence, so the block below is for reading, not for Gmail. None of this is
 * documented; it improves the odds and guarantees nothing, and the sender's reputation
 * and the reader's account weigh in too.
 *
 * The code is one run of digits in one element, spaced out by `letter-spacing` rather
 * than split into a box per digit. Split boxes look like a keypad, but selecting them by
 * hand copies the gaps between them, and a code that pastes as "6 2 2 4 6 8" is a field
 * that refuses it.
 *
 * The code is out of the subject, where it used to lead, because the message that got the
 * card had none there and a code a reader can already see is one Gmail may not bother to
 * offer. Little is lost: a phone's notification shows the first line of the body under
 * the subject, and that line is the code, and iOS finds a code in the body to offer above
 * the keyboard.
 *
 * Tables and inline styles because that is all email clients agree on: Gmail drops a
 * `<style>` block's selectors in places and Outlook lays out nothing else. The colours
 * are the web app's light palette (`styles.css`), and the message deliberately does not
 * declare `color-scheme: light dark`: that tells Apple Mail the message handles dark mode
 * itself, which it cannot without a stylesheet, and the result is this dark text on the
 * client's dark page. Undeclared, each client recolours it the way it does any light
 * message, or shows it light.
 *
 * Centred as one column, all three lines together. Left-aligned, the fine print ran
 * wider than the code above it and read as a ragged block; centring it alone would put
 * it out of line with the lines above. `align` beside `text-align` because Outlook reads
 * only the attribute.
 */

export interface SignInCodeEmail {
  subject: string;
  text: string;
  html: string;
}

const SUBJECT = 'Your Unbent sign-in code';
const FINE_PRINT = 'Do not share it with anyone. It expires in five minutes and can be used once. If you did not ask to sign in, you can ignore this email.';

export function signInCodeEmail(otp: string): SignInCodeEmail {
  const code = escapeHtml(otp);
  return {
    subject: SUBJECT,
    text: `Your Unbent sign-in code is ${otp}\n\n${FINE_PRINT}`,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SUBJECT}</title>
</head>
<body style="margin:0;padding:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;margin:0 auto;text-align:center;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1a17;">
<tr><td align="center" style="font-size:16px;line-height:24px;padding:0 0 12px;">Your Unbent sign-in code is</td></tr>
<tr><td align="center" style="padding:0 0 24px;"><div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;line-height:40px;font-weight:600;letter-spacing:6px;padding:12px 14px 12px 20px;background-color:#f1eee9;border:1px solid #e3ded7;border-radius:8px;">${code}</div></td></tr>
<tr><td align="center" style="font-size:14px;line-height:20px;color:#6b6560;">${FINE_PRINT}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
  };
}

/**
 * Better Auth's codes are digits, so this changes nothing today. It is here so that a
 * longer or alphanumeric code (a plugin option away) can never become markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
