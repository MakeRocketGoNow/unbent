import type { AppConfig } from '@unbent/shared';
import type { CaptureResult } from 'posthog-js';
import { addErrorSink, routeOf } from './report-error.js';

/**
 * PostHog, as an error tracker and nothing else.
 *
 * `/api/client-errors` logs every report into the Worker's own logs, which every instance
 * has and which keeps them for three days with no grouping and no way to mark one fixed.
 * This is the second destination for an instance that wants those things — see
 * `addErrorSink`, which is why this is additional rather than a replacement.
 *
 * What it deliberately is not is analytics. Page views are counted by the hosting provider,
 * which sets no cookie and assigns no identifier, and moving them here would trade that for
 * a worse answer. So every capture path the SDK has is switched off in `init` and then
 * switched off again in `before_send`: two mechanisms rather than one, because a default
 * that changes in a future version must not quietly turn this into a tracker.
 *
 * The configuration below is what lets the privacy policy keep saying nothing tracks you:
 *
 * - `cookieless_mode: 'always'` stores nothing in the browser at all — no cookie, no
 *   localStorage. People are counted by a hash PostHog computes server-side from a salt it
 *   discards daily, so there is no identifier that outlives a day and `identify` is a
 *   no-op. NOTE: this needs "Cookieless server hash mode" enabled in the PostHog project;
 *   with it off, events are dropped server-side and nothing here reports a problem.
 * - `person_profiles: 'never'` means no person records are built.
 * - `autocapture: false` and `disable_session_recording: true` mean nothing about what is
 *   on screen or typed is ever observed. The app is a notes editor; a session recording of
 *   it is a recording of somebody's notes.
 * - `respect_dnt: true` sends nothing at all from a browser asking not to be tracked.
 *
 * Exceptions arrive through `addErrorSink` rather than through the SDK's own
 * `capture_exceptions`. `report-error.ts` already listens on `window`, dedupes by message
 * and caps a render loop at five; enabling the SDK's autocapture would add a second pair of
 * listeners with neither of those bounds and report everything twice.
 */

/** Where the Worker proxies this traffic. See `routes/ingest.ts` for why it is proxied. */
const INGEST_PATH = '/ingest';

/**
 * The last gate before an event leaves the browser.
 *
 * Returning null drops the event. Only exceptions pass, so a capture path enabled by a
 * future default — a pageview, a survey shown, a flag evaluated — is dropped here even
 * though `init` already asked for it to be off.
 *
 * The URL is replaced rather than trimmed. PostHog fills `$current_url` from `location`,
 * which on this app carries a note id in the path and a search term in the query string;
 * `routeOf` is the same redaction the first-party report already applies. The referrer goes
 * for a related reason: on a note it is another note's address.
 */
export function scrub(event: CaptureResult | null): CaptureResult | null {
  if (!event || event.event !== '$exception') return null;

  const route = routeOf();
  event.properties['$current_url'] = route;
  event.properties['$pathname'] = route;
  delete event.properties['$referrer'];
  delete event.properties['$referring_domain'];
  delete event.$set;
  delete event.$set_once;
  return event;
}

/**
 * Loads the SDK and registers it as a second destination for reports.
 *
 * Dynamically imported, so an instance that has not configured PostHog never downloads it:
 * the bundle is a separate chunk that is only fetched when this runs.
 *
 * Never throws. A blocked script, a failed init or a network the SDK cannot reach are all
 * reasons to have no error tracking, not reasons to break the app that was trying to set it
 * up — and rule 1 of `report-error.ts` applies to its sinks as much as to itself.
 */
export async function installPosthog(config: NonNullable<AppConfig['posthog']>): Promise<void> {
  try {
    const { default: posthog } = await import('posthog-js');

    posthog.init(config.key, {
      // Same origin, so a content blocker does not drop the reports; the Worker forwards.
      api_host: `${location.origin}${INGEST_PATH}`,
      // Still the real host: the toolbar and the links in the SDK's own UI point at it.
      ui_host: config.uiHost,
      cookieless_mode: 'always',
      person_profiles: 'never',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      respect_dnt: true,
      before_send: scrub,
    });

    // The thrown value rather than its message: PostHog parses an `Error` into frames, and
    // a stack it reconstructed from a string groups worse than the one it was given.
    addErrorSink((report) =>
      posthog.captureException(report.value, { kind: report.kind, route: report.route }),
    );
  } catch {
    // See above: no error tracking is a worse outcome than having it, not a broken app.
  }
}
