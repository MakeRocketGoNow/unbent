import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { request } from '../notes-api.js';
import { Button } from './Button.js';

/**
 * Fills the account with the seed (`@unbent/seed`), on a pull-request preview whose note
 * stores are its own (`AppConfig.ownStores`).
 *
 * Such a preview exists because its PR changes the note store, and only stores of its own
 * run that code; the dev instance's would answer with `main`'s. They start empty, and a
 * store change tried against an empty account proves very little, so the page offers the
 * same notes `pnpm seed:demo` loads locally — notebooks with every kind of field, receipts
 * with files, the layout's awkward cases. It loads through this preview's own API, so what
 * writes and reads them is the branch's store.
 *
 * In the page rather than in the deploy, because the deploy has no session: the notes go
 * into whichever account is signed in, and only the page knows who that is. Offered, not
 * automatic, so nobody signs in to a preview and finds four hundred notes they did not
 * ask for — and so a preview that is meant to be tested empty can be.
 *
 * The seed is imported when the button is pressed, as a chunk of its own: no instance
 * but these previews ever needs it, so nothing else downloads it.
 */
export function SampleNotes({ layout }: { layout: 'empty' | 'section' }) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  async function fill() {
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: 0 });
    try {
      const { loadSeed } = await import('@unbent/seed');
      const counts = await loadSeed({
        request,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(
        counts.created > 0
          ? `Added ${counts.created} notes${counts.updated ? `, updated ${counts.updated}` : ''}.`
          : `Updated ${counts.updated} notes; nothing was missing.`,
      );
      // Everything a list, a count or a notebook menu shows has changed.
      void queryClient.invalidateQueries();
    } catch (err) {
      setError((err as Error).message || 'Could not add the sample notes.');
    } finally {
      setProgress(null);
    }
  }

  const label = !progress
    ? 'Fill with sample notes'
    : progress.total === 0
      ? 'Starting…'
      : `Adding… ${progress.done} of ${progress.total}`;

  const button = (
    <Button size="small" disabled={busy} onClick={() => void fill()}>
      {label}
    </Button>
  );
  const status = (
    <>
      {result && <span className="good small">{result}</span>}
      {error && <span className="bad small">{error}</span>}
    </>
  );

  if (layout === 'empty') {
    return (
      <div className="sample-notes">
        <p className="muted small">
          This preview keeps notes of its own, because its pull request changes how they are
          stored. Fill it with invented notes to try the change on.
        </p>
        <div className="backfill-row">
          {button}
          {status}
        </div>
      </div>
    );
  }

  return (
    <section className="settings-section">
      <h3>Sample notes</h3>
      <p className="muted small">
        This preview keeps notes of its own, because its pull request changes how they are
        stored, so they start empty. This adds about four hundred invented ones: notebooks
        with every kind of field, receipts with files to search, a few in the trash.
        Running it again updates them rather than adding more.
      </p>
      <div className="backfill-row">
        {button}
        {status}
      </div>
    </section>
  );
}
