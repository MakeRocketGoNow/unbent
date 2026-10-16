#!/usr/bin/env node
/**
 * Prints the client secret Sign in with Apple wants in `APPLE_CLIENT_SECRET`.
 *
 * Apple has no static secret. The "secret" is a JWT the operator signs with a Sign in with
 * Apple key from the developer portal, naming the team, the key and the Services ID, and
 * Apple refuses one that expires more than six months after it was issued. So it is not set
 * once: it is regenerated before it lapses, and when it does lapse the web Apple button
 * fails at the code exchange while every other sign-in keeps working (easy to miss).
 *
 *   node scripts/apple-client-secret.mjs --team TEAMID --key-id KEYID \
 *     --client-id com.example.notes.web --key AuthKey_KEYID.p8 \
 *     | pnpm --dir apps/api exec wrangler secret put APPLE_CLIENT_SECRET
 *
 * The token goes to stdout and nothing else does, so it can be piped straight into
 * wrangler without passing through a terminal's scrollback; the expiry date goes to stderr.
 * `--days` shortens the lifetime (default and maximum 180).
 *
 * Web Crypto rather than a JOSE library: the repository root has no dependencies to lean
 * on, and an ES256 JWT is a header, a payload and one `sign` call. `subtle.sign` already
 * returns the raw r‖s signature JWS expects, not DER.
 *
 * Generating this inside the Worker at runtime, from the key itself, would retire the
 * script and the calendar reminder together. It is not done yet because it means holding
 * the `.p8` as a secret and caching the signed token across isolates; until then, this.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** Apple's ceiling is 15,777,000 seconds, a little over 182 days; 180 keeps clear of it. */
const MAX_DAYS = 180;

const { values } = parseArgs({
  options: {
    team: { type: 'string' },
    'key-id': { type: 'string' },
    'client-id': { type: 'string' },
    key: { type: 'string' },
    days: { type: 'string', default: String(MAX_DAYS) },
  },
});

const missing = ['team', 'key-id', 'client-id', 'key'].filter((name) => !values[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.map((name) => `--${name}`).join(', ')}.`);
  console.error(
    'Usage: node scripts/apple-client-secret.mjs --team TEAMID --key-id KEYID --client-id SERVICES_ID --key AuthKey.p8 [--days 180]',
  );
  process.exit(1);
}

const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
  console.error(`--days must be a whole number from 1 to ${MAX_DAYS}.`);
  process.exit(1);
}

// The .p8 is a PKCS#8 PEM; Web Crypto takes the DER inside it.
const pem = readFileSync(values.key, 'utf8');
const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const key = await crypto.subtle.importKey(
  'pkcs8',
  der,
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);

const now = Math.floor(Date.now() / 1000);
const exp = now + days * 24 * 60 * 60;
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const input = `${part({ alg: 'ES256', kid: values['key-id'] })}.${part({
  iss: values.team,
  iat: now,
  exp,
  aud: 'https://appleid.apple.com',
  sub: values['client-id'],
})}`;
const signature = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  key,
  new TextEncoder().encode(input),
);

process.stdout.write(`${input}.${Buffer.from(signature).toString('base64url')}\n`);
console.error(`Expires ${new Date(exp * 1000).toISOString().slice(0, 10)}; regenerate before then.`);
