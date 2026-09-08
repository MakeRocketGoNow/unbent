/**
 * Sends a crash in this page to the Worker, where its logs already are.
 *
 * The reason this exists is the Android app: the editor is this site in a WebView, so a
 * JavaScript error there is invisible to Play's crash reporting — the process never dies,
 * and to Android nothing happened. See `apps/api/src/routes/client-errors.ts` for why the
 * far end is unauthenticated and what it does with a report.
 *
 * Three rules hold this together, and all three exist because a reporter that misbehaves is
 * worse than no reporter at all:
 *
 * 1. It must never throw. Anything raised inside a global error handler is either swallowed
 *    or re-enters that handler; both make the original error harder to find. Every path is
 *    wrapped, including the send.
 * 2. It must not report itself. A failing POST that reports its own failure is an infinite
 *    loop pointed at the server. The send's own errors are dropped on the floor.
 * 3. It must be bounded. A render loop can throw thousands of times a second, so a cap and
 *    a duplicate filter sit in front of the network — see `sent` and `MAX_REPORTS`.
 */

/**
 * The most reports one page load will ever send.
 *
 * A component that throws on every render does so as fast as React can call it, and each
 * one would otherwise be a request. Five is enough to see a pattern; the difference between
 * five and five thousand is server load, not information.
 */
const MAX_REPORTS = 5;

/** Stacks are truncated here as well as at the far end — a long one is mostly framework. */
const MAX_STACK = 4000;

/**
 * Messages already reported by this page, so a loop sends once rather than to the cap.
 *
 * Keyed on the message alone rather than the stack: the same fault reached by two render
 * paths is one bug, and reporting it twice tells us nothing the first did not.
 */
const sent = new Set<string>();
let count = 0;

/** The thrown value's message, whatever it happens to be. */
function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A value whose own serialization throws — a circular structure, a hostile getter.
    return String(value);
  }
}

function stackOf(value: unknown): string | undefined {
  return value instanceof Error && value.stack ? value.stack.slice(0, MAX_STACK) : undefined;
}

/**
 * The route this happened on, without the query string.
 *
 * `pathname` rather than `href` deliberately: a note id in the path says which note someone
 * was reading, and a query string can carry a search term. Neither belongs in a log that
 * exists to find broken code. What is kept is the shape of the route, which is the part
 * that says where to look.
 */
function routeOf(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  return location.pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(\/|$)/i, '/:id$1');
}

export function reportError(value: unknown, kind: 'error' | 'rejection'): void {
  try {
    if (count >= MAX_REPORTS) return;
    const message = messageOf(value).slice(0, 1000);
    if (!message || sent.has(message)) return;
    sent.add(message);
    count += 1;

    const body = JSON.stringify({
      message,
      stack: stackOf(value),
      route: routeOf(),
      kind,
    });

    /*
     * `keepalive` so a report survives the navigation that often follows the error — an
     * ordinary fetch is cancelled when the page goes away, which loses exactly the reports
     * from errors bad enough to make someone leave. `sendBeacon` would do the same, but it
     * cannot set a content type this endpoint will accept.
     *
     * The rejection handler is rule 2: this fetch failing must not become another report.
     */
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Rule 1. There is nothing useful to do here, and throwing would bury the real error.
  }
}

/**
 * Installs the two global handlers. Returns the teardown, which tests use; the app calls
 * this once at startup and never removes them.
 *
 * `error` catches thrown exceptions that reach the window, `unhandledrejection` the
 * promises nobody caught — the second is the one that matters for this app, since an
 * awaited fetch that rejects is how most of its failures actually look.
 */
export function installErrorReporting(): () => void {
  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message, 'error');
  const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason, 'rejection');

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Test seam: forgets what this page has already sent. Not called by the app. */
export function resetErrorReporting(): void {
  sent.clear();
  count = 0;
}
