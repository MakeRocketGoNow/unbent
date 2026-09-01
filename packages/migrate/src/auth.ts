/**
 * Signing the CLI in, without it ever handling a credential.
 *
 * The device flow (RFC 8628): ask for a code, show it to the user, wait while they approve
 * it in a browser they are already signed in to, then collect an ordinary session token.
 * Nothing is typed into this process and no password is ever read from a terminal.
 */

export interface DeviceCodeGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  /** Seconds the server wants between polls. Honoured, and raised on slow_down. */
  interval: number;
}

/** The identifier shown on the approval page, so the user knows what is asking. */
export const CLIENT_ID = 'unbent-migrate';

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    // JSON, not the form encoding RFC 8628 specifies: better-auth's endpoint rejects
    // application/x-www-form-urlencoded with a 415.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${res.status} from ${path}: ${text.slice(0, 200)}`);
  }
  // The token endpoint signals pending/denied through 400 bodies, so the caller has to see
  // those rather than have them thrown; only genuinely unexpected statuses throw here.
  if (!res.ok && res.status !== 400) {
    throw new Error(`${res.status} from ${path}: ${text.slice(0, 200)}`);
  }
  return parsed as T;
}

/** Starts a flow. The returned code is what the user types or clicks through to. */
export function requestDeviceCode(baseUrl: string): Promise<DeviceCodeGrant> {
  return post<DeviceCodeGrant>(baseUrl, '/api/auth/device/code', { client_id: CLIENT_ID });
}

type TokenResponse =
  | { access_token: string; token_type: string; expires_in: number }
  | { error: string; error_description?: string };

/**
 * Polls until the user decides, then returns the bearer token.
 *
 * `authorization_pending` is the normal case and simply means keep waiting. `slow_down` is
 * the server asking for a longer gap, and per the RFC the increase must persist rather
 * than applying to a single sleep.
 */
export async function waitForToken(
  baseUrl: string,
  grant: DeviceCodeGrant,
  options: {
    signal?: AbortSignal;
    /**
     * How to wait between polls. Injected so tests can drive the loop without sleeping
     * through a real five-second backoff.
     */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + grant.expires_in * 1000;
  let interval = Math.max(1, grant.interval) * 1000;

  for (;;) {
    if (options.signal?.aborted) throw new Error('Sign-in cancelled.');
    if (Date.now() > deadline) {
      throw new Error('That code expired before it was approved. Run the command again.');
    }

    await sleep(interval);

    const body = await post<TokenResponse>(baseUrl, '/api/auth/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });

    if ('access_token' in body) return body.access_token;

    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (body.error === 'access_denied') {
      throw new Error('That request was denied in the browser. Nothing was granted.');
    }
    if (body.error === 'expired_token') {
      throw new Error('That code expired before it was approved. Run the command again.');
    }
    throw new Error(body.error_description ?? body.error);
  }
}
