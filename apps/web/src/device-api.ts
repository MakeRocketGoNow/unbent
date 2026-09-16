import { ApiError } from './notes-api.js';

/**
 * The browser half of the device authorization flow (RFC 8628).
 *
 * A CLI cannot hold a credential safely, so instead it prints a short code and asks the
 * user to approve it here, in a browser already signed in. These three calls are what that
 * approval needs: claim the code, then approve or deny it.
 *
 * Written as plain fetch rather than through the better-auth client plugin, which only
 * declares path-to-method mappings and leaves the call signatures to inference. The shapes
 * here were verified against the running Worker.
 */

/** What a pending code says about itself, shown to the user before they approve. */
export interface DeviceCodeInfo {
  user_code: string;
  status: string;
  /** Which program is asking. Null when the CLI sent no client_id. */
  client_id: string | null;
  scope: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Claims a user code for the current session, and reports what it belongs to.
 *
 * Required before approve or deny will do anything: the code is created by an
 * unauthenticated CLI and has no user attached until a signed-in browser claims it.
 * Approving without this step fails with "not been claimed by a verifying session".
 */
export function claimDeviceCode(userCode: string): Promise<DeviceCodeInfo> {
  return fetch(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
    credentials: 'include',
  }).then(json<DeviceCodeInfo>);
}

function decide(path: 'approve' | 'deny', userCode: string): Promise<{ success: boolean }> {
  return fetch(`/api/auth/device/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userCode }),
  }).then(json<{ success: boolean }>);
}

/** Grants the waiting device a session. It is polling and will pick this up within ~5s. */
export const approveDeviceCode = (userCode: string) => decide('approve', userCode);

/** Refuses the waiting device. Its next poll gets `access_denied` and it stops. */
export const denyDeviceCode = (userCode: string) => decide('deny', userCode);

/**
 * Mints a short-lived token that a native app trades for a session.
 *
 * The counterpart to the device-code flow, for a client that *can* be redirected back to.
 * The phone opens /connect in a Custom Tab carrying the browser's cookies, so this call is
 * authenticated by whatever provider the user signed in with — the app never sees a
 * credential, and nothing is typed or read out.
 */
export function mintConnectToken(): Promise<string> {
  return fetch('/api/auth/one-time-token/generate', {
    credentials: 'include',
  })
    .then(json<{ token: string }>)
    .then((r) => r.token);
}

/**
 * Trades a one-time token from the dev instance for a session on *this* origin.
 *
 * The redeeming half of the preview sign-in relay: a preview reaches `/preview-signin` with
 * a token minted by the dev instance's `/api/preview-relay/start`, and this hands it to
 * Better Auth's verify endpoint. Because the relay's `oneTimeToken()` sets the session
 * cookie on the verifying origin, the `Set-Cookie` that comes back establishes the session
 * here — the preview's own host-only cookie — which is the whole point: previews share the
 * dev instance's database, so a token minted there names a session valid here.
 *
 * Plain fetch rather than the client plugin for the same reason `mintConnectToken` is: the
 * one-time-token client methods only map paths to names and leave the call shape to
 * inference. `credentials: 'include'` so the response's cookie is stored.
 */
export function redeemPreviewToken(token: string): Promise<void> {
  return fetch('/api/auth/one-time-token/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ token }),
  }).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ApiError(
        res.status,
        `${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
      );
    }
  });
}
