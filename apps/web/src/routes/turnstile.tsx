import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { postToApp } from '../app-bridge.js';
import { Turnstile } from '../components/Turnstile.js';
import { configQuery } from '../queries.js';

/**
 * Mints a Turnstile token for the native apps, which have no widget of their own.
 *
 * Where the instance checks a token with every request for a sign-in code (MAK-243), the
 * Android and iOS sign-in screens, which make that request themselves, need one too.
 * Turnstile runs in a browser and nowhere else, so each app loads this page in a web view
 * it keeps off screen, and the page says what the widget concluded through the bridge:
 * `turnstile` with the token, or `turnstile-error`. If the widget is about to want a tap,
 * which a hidden view cannot be given, the page says `turnstile-interactive` first and the
 * app brings the view on screen. The token is spent by one request, so the app loads this
 * page again for the next.
 *
 * It reads the site key from `/api/config` as the sign-in screen does, rather than being
 * told it, so the app and the page cannot disagree about which instance's key this is.
 * An instance that asks for no token answers with an error: the app only loads the page
 * when its own read of the config says to, so that is a deploy in between, not a path.
 *
 * What the page shows is for the developer who opens it in a browser; the app reads only
 * the bridge.
 */
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
    const message = config.isError ? 'Could not read the instance\'s settings.' : 'This instance asks for no token.';
    setLine(message);
    postToApp({ type: 'turnstile-error', message });
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
            setLine('The widget could not run.');
            postToApp({ type: 'turnstile-error', message: 'The widget could not run.' });
          }}
          onInteractive={() => postToApp({ type: 'turnstile-interactive' })}
        />
      )}
      <p className="muted small">{line}</p>
    </div>
  );
}
