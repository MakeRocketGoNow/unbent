import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { postToApp } from '../app-bridge.js';
import { Turnstile } from '../components/Turnstile.js';
import { configQuery } from '../queries.js';

/**
 * Mints a Turnstile token for the native apps, which have no widget of their own.
 *
 * Where the instance checks a token with every request for a sign-in code and every
 * exchange of a provider's ID token (MAK-243), the Android and iOS sign-in screens, which
 * make those requests themselves, need one too.
 * Turnstile runs in a browser and nowhere else, so each app loads this page in a web view
 * it keeps off screen, and the page says what the widget concluded through the bridge:
 * `turnstile` with the token, or `turnstile-error`. If the widget is about to want a tap,
 * which a hidden view cannot be given, the page says `turnstile-interactive` first and the
 * app brings the view on screen. The token is spent by one request, so the app loads this
 * page again for the next.
 *
 * It reads the site key from `/api/config` as the sign-in screen does, rather than being
 * told it, so the app and the page cannot disagree about which instance's key this is.
 * An instance that asks for no token gets `turnstile-none`, and the app sends without
 * one: the app only loads the page when its own read of the config says to, so this is
 * the check having been turned off since, and a press that fails over it would fail
 * until the app read the config again.
 *
 * What the page shows is for the developer who opens it in a browser; the app reads only
 * the bridge. The widget sits at the very top of the page (`.turnstile-page`), because the
 * apps draw the page in a box exactly the widget's height.
 */
const WIDGET_FAILED = 'The widget could not run.';

export const Route = createFileRoute('/turnstile')({
  component: TurnstilePage,
});

export function TurnstilePage() {
  const config = useQuery(configQuery());
  const [line, setLine] = useState('Checking…');
  const siteKey = config.data?.turnstile?.siteKey;
  const noKey = config.isError || (config.isSuccess && !siteKey);

  useEffect(() => {
    if (!noKey) return;
    if (config.isError) {
      const message = 'Could not read the instance\'s settings.';
      setLine(message);
      postToApp({ type: 'turnstile-error', message });
    } else {
      setLine('This instance asks for no token.');
      postToApp({ type: 'turnstile-none' });
    }
  }, [noKey, config.isError]);

  return (
    <div className="turnstile-page">
      {siteKey && (
        <Turnstile
          siteKey={siteKey}
          onToken={(token) => {
            if (!token) return;
            setLine('Token minted.');
            postToApp({ type: 'turnstile', token });
          }}
          onFail={() => {
            setLine(WIDGET_FAILED);
            postToApp({ type: 'turnstile-error', message: WIDGET_FAILED });
          }}
          onInteractive={() => postToApp({ type: 'turnstile-interactive' })}
        />
      )}
      <p className="muted small">{line}</p>
    </div>
  );
}
