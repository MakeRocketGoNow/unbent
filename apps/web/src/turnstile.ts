/**
 * Cloudflare Turnstile's script, loaded where the instance has put a check in front of
 * the request for a sign-in code and the start of a provider sign-in (MAK-243).
 *
 * The script is Cloudflare's own, from its CDN, and it is what draws the widget: the
 * challenge runs in an iframe on challenges.cloudflare.com, which is the point of it, and
 * what it concludes comes back as a token the server checks (`captcha` in
 * `apps/api/src/auth.ts`). A third party on the page all the same, so it is fetched only
 * when a screen draws the widget and only where `/api/config` carries a site key, the
 * way Paddle.js is fetched on the Subscribe press (`paddle.ts`): an instance that has not
 * set the pair never loads it, and nothing about it is in the build.
 *
 * Not the npm wrapper, for the reason `paddle.ts` gives: a package around a script tag is
 * one more thing to hold back (DEPENDENCIES.md), and the surface used here is three calls.
 *
 * `?render=explicit` keeps the script from scanning the page for a widget to draw by
 * itself; the component renders into the element it owns and removes it on unmount.
 *
 * Nothing here is cached by the service worker: its routes answer same-origin reads and
 * nothing else (`sw/routes.ts`, `isAsset` and `classify` both check the origin), so a
 * challenge is always Cloudflare's own and a page offline simply has no widget. The
 * sign-in screen says so instead of waiting (`Turnstile` component's `onFail`).
 */

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * The header the token travels in, which is the one the server's plugin reads. The
 * native apps send the same header from their own requests (`EmailOtpAuth.kt` and
 * `GoogleAuth.kt`, `SignInCalls.swift` and `NativeSignIn.swift`) with a token the
 * `/turnstile` page minted for them.
 */
export const CAPTCHA_HEADER = 'x-captcha-response';

export interface TurnstileOptions {
  sitekey: string;
  /** A token, when the widget passes the browser. Single use: the next request wants a new one. */
  callback: (token: string) => void;
  /** The token has lapsed (they live a few minutes) and the widget is minting another. */
  'expired-callback'?: () => void;
  /** The widget could not run: no connection to Cloudflare, a content blocker, a bad key. */
  'error-callback'?: (code: string) => void;
  /** The widget is about to need a click or a tap, which a hidden one cannot be given. */
  'before-interactive-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
  appearance?: 'always' | 'execute' | 'interaction-only';
}

export interface TurnstileJs {
  render(container: HTMLElement, options: TurnstileOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileJs;
  }
}

let loading: Promise<TurnstileJs> | null = null;

/** Turnstile's script, loaded once. A failed load is not final: the next screen tries again. */
export function loadTurnstile(): Promise<TurnstileJs> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileJs>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.onload = () =>
        window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile loaded but left nothing on the page'));
      script.onerror = () => reject(new Error('Turnstile could not be loaded'));
      document.head.appendChild(script);
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
