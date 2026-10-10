import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { indexPendingFiles } from '../attachment-text.js';
import { isStatus } from '../notes-api.js';
import { postToApp } from '../app-bridge.js';

/**
 * Indexes one note's PDFs, for the Android app to run in a WebView it never shows.
 *
 * The app's share sheet uploads a capture without any page — a background job streams
 * the files to the API — so nothing extracts their text the way the editor does for its
 * own uploads. pdf.js is the one extractor this project has and it lives in the browser;
 * the app has a browser. So after the upload the app loads this page, off screen, with
 * the note's id, and it does for that one note what Maintenance's button does for
 * the account.
 *
 * `note` is required: this page is never a backlog runner. A phone must not be handed
 * four thousand scans to pull over a radio, and the pass the shell makes on open is
 * where a small backlog gets caught anyway.
 *
 * Extraction runs on this page's own thread rather than in the import worker. There is
 * nothing here to keep responsive, and a hidden WebView is already one layer that can die
 * without a word; a worker nested inside it would be another, with nothing to show for it.
 *
 * What the page shows is for the developer who opens it in a browser to see what the app
 * sees; the app reads only the bridge.
 */
export const Route = createFileRoute('/embed/index-files')({
  validateSearch: z.object({ note: z.string().min(1) }),
  component: IndexFilesRoute,
});

function IndexFilesRoute() {
  const { note } = Route.useSearch();
  return <IndexFiles note={note} />;
}

/** The page's whole behaviour, apart from reading `note` off the URL — so a test can hand it one. */
export function IndexFiles({ note }: { note: string }) {
  const [line, setLine] = useState('Indexing…');

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    postToApp({ type: 'ready' });

    indexPendingFiles({
      note,
      signal: controller.signal,
      onProgress: (p) => {
        if (!live()) return;
        setLine(`Indexing… ${p.done} of ${p.total}`);
        postToApp({ type: 'index-progress', done: p.done, total: p.total });
      },
    }).then(
      (result) => {
        if (!live()) return;
        setLine(`Indexed ${result.indexed} of ${result.done}.`);
        postToApp({
          type: 'index-done',
          indexed: result.indexed,
          unusable: result.unusable,
          failed: result.failed,
        });
      },
      (err: unknown) => {
        if (!live()) return;
        if (isStatus(err, 401)) {
          setLine('Not signed in.');
          postToApp({ type: 'unauthorized' });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setLine(`Could not index: ${message}`);
        postToApp({ type: 'index-error', message });
      },
    );

    // StrictMode runs an effect twice in development; the cleanup abandons the first
    // run before it can report, so the app hears one story.
    return () => controller.abort();
  }, [note]);

  return (
    <section>
      <p className="muted placeholder">{line}</p>
    </section>
  );
}
