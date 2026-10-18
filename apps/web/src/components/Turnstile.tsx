import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { emailOtp } from '../auth-client.js';
import { keys } from '../queries.js';
import { CAPTCHA_HEADER, loadTurnstile } from '../turnstile.js';

/** What the sentence under a widget that could not run says; the one place it is worded. */
export const TURNSTILE_FAILED_MESSAGE =
  'The check before signing in could not load. Check your connection, then reload this page.';

/**
 * What a request refused for carrying no token says, in place of the plugin's own
 * "Missing CAPTCHA response": the instance turned the check on after this screen read
 * its config, the widget is being drawn now, and the next press carries a token. The
 * apps say the same in their own words.
 */
export const CHECK_TURNED_ON_MESSAGE =
  'This instance now checks your browser before signing in. Press the button again.';

export interface TurnstileProps {
  siteKey: string;
  /**
   * The token, each time the widget mints one, and null when the last one has lapsed.
   * A token is spent by one request: a screen that has sent it needs the widget drawn
   * again for the next, which a change of `key` on this component does.
   */
  onToken: (token: string | null) => void;
  /** The widget could not run, or the script never arrived. Said once; the widget stays blank. */
  onFail: () => void;
  /**
   * The widget is about to ask for a click. Only a host that drew it off screen cares:
   * the `/turnstile` page tells the app, which brings the view on screen.
   */
  onInteractive?: () => void;
}

/**
 * Cloudflare's Managed widget, drawn where the instance asks for a token with the request
 * for a sign-in code or the start of a provider sign-in (MAK-243; `turnstile.ts` says why
 * the script and not a package).
 *
 * Managed, which decides for itself whether to ask for a click: nearly everyone sees a
 * box that marks itself done in a second, and a browser Cloudflare is unsure of is asked
 * to tap once. Drawn from the start rather than on the press that needs it (`appearance:
 * 'always'`): a widget that appeared under a pressed button would move the button, and
 * the token is usually in hand before anyone has finished typing an address.
 *
 * `flexible` fills the form's column, which is the width the fields above it have. The
 * theme follows the page's, as the fields do. The container has the widget's height before
 * the script arrives (`.turnstile` in the stylesheet), so nothing below it jumps when it does.
 *
 * The callbacks are held in a ref and the widget is rendered once per mount: Turnstile
 * keeps its own copy of the options, so a re-render with a new closure must not draw a
 * second widget, and a parent that wants a fresh token remounts this with a new `key`.
 */
export function Turnstile({ siteKey, onToken, onFail, onInteractive }: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onToken, onFail, onInteractive });
  handlers.current = { onToken, onFail, onInteractive };

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let widgetId: string | undefined;
    let gone = false;
    loadTurnstile().then(
      (turnstile) => {
        if (gone) return;
        try {
          widgetId = turnstile.render(element, {
            sitekey: siteKey,
            theme: 'auto',
            size: 'flexible',
            appearance: 'always',
            callback: (token) => handlers.current.onToken(token),
            'expired-callback': () => handlers.current.onToken(null),
            'error-callback': () => handlers.current.onFail(),
            'before-interactive-callback': () => handlers.current.onInteractive?.(),
          });
        } catch {
          // A key the script refuses, or a container it cannot draw in: the same dead end
          // as a script that never arrived, and reported the same way.
          handlers.current.onFail();
        }
      },
      () => {
        if (!gone) handlers.current.onFail();
      },
    );
    return () => {
      gone = true;
      // A token the widget minted dies with it: nothing can hear it expire once the
      // widget is gone, and a screen that kept it would send a dead token minutes later.
      handlers.current.onToken(null);
      if (widgetId !== undefined) {
        try {
          window.turnstile?.remove(widgetId);
        } catch {
          // Already gone with the page; nothing to take back.
        }
      }
    };
  }, [siteKey]);

  return <div className="turnstile" ref={container} />;
}

/** The shape every Better Auth client call answers with, as far as the gate reads it. */
type Answer = { error?: { code?: string; message?: string } | null } | null | undefined;

/**
 * The instance's check, where it has one, in front of the requests a screen makes that
 * the server gates (MAK-243): a request for a sign-in code, and the start of a provider
 * sign-in, which is a sign-up where the allowlist is empty and the door a script with
 * throwaway Google accounts walks in by.
 *
 * One widget per screen, whatever it offers: the token is the browser's, not the
 * button's, so the sign-in screen draws one widget above its first gated button and
 * every gated press waits on it. What it costs a screen is in one place: the widget to
 * draw (`widget`, null where the instance asks for no token), whether a press may go yet
 * (`ready`: a token in hand, or none needed, with `waiting` as the reason for the faded
 * button while it is not), the sentence to show when the widget could not run
 * (`failed`), and `through`, which makes a request with the token in `CAPTCHA_HEADER`
 * and spends it. Spent whatever the answer: Cloudflare takes a token once, and one the
 * server refused is no use a second time, so the widget is drawn again (a new `key`)
 * for the next press.
 *
 * Without a site key the request is what it was, with no header: a server that asks for
 * none must be sent none, and a test that asserts the call's shape sees the same call.
 */
export function useTurnstileGate(siteKey: string | undefined) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  const widget = siteKey ? (
    <Turnstile
      key={generation}
      siteKey={siteKey}
      onToken={(t) => {
        setToken(t);
        // Turnstile retries most of its own errors (`retry: 'auto'`), so a token after a
        // failure means the failure is over, and the sentence for it comes down.
        if (t) setFailed(false);
      }}
      onFail={() => setFailed(true)}
    />
  ) : null;

  /**
   * Makes the request, with the token where the instance asks for one. The request is
   * given the `fetchOptions` to send, or nothing where there is no check, so the call's
   * shape without a check is the call as it was.
   */
  async function through<T extends Answer>(
    request: (fetchOptions?: { headers: Record<string, string> }) => Promise<T>,
  ): Promise<T> {
    if (siteKey) {
      try {
        return await request({ headers: { [CAPTCHA_HEADER]: token ?? '' } });
      } finally {
        setToken(null);
        setGeneration((g) => g + 1);
      }
    }
    const result = await request();
    if (result?.error?.code === 'MISSING_RESPONSE') {
      // The instance started asking for a token after this screen read its config, which
      // is held for the life of the page. Read it again, so the next render draws the
      // widget and the next press carries a token, rather than every press failing the
      // same way until a reload. The old config stays drawn while the new one arrives.
      void queryClient.invalidateQueries({ queryKey: keys.config() });
      return { ...result, error: { ...result.error, message: CHECK_TURNED_ON_MESSAGE } };
    }
    return result;
  }

  const ready = !siteKey || token !== null;
  return {
    widget,
    ready,
    /** Why the button is faded, for its `tip`, since a disabled button cannot say so itself. */
    waiting: ready || failed ? undefined : 'Waiting for the check above to finish',
    failed,
    through,
  };
}

export type TurnstileGate = ReturnType<typeof useTurnstileGate>;

/** A request for a sign-in code, through the gate. */
export function requestCode(gate: TurnstileGate, email: string) {
  return gate.through((fetchOptions) =>
    emailOtp.sendVerificationOtp(
      fetchOptions ? { email, type: 'sign-in', fetchOptions } : { email, type: 'sign-in' },
    ),
  );
}

/**
 * The gate with the code request on it, for a screen that asks for a code and nothing
 * else the instance gates: Security's re-verification before a passkey is added. The
 * sign-in screen holds the gate itself, since its provider buttons go through it too.
 */
export function useCodeRequest(siteKey: string | undefined) {
  const gate = useTurnstileGate(siteKey);
  return { ...gate, send: (email: string) => requestCode(gate, email) };
}
