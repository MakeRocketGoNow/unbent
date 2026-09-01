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
