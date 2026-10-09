import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { Button } from './Button.js';
import { savedAs, startExport, stopExport, useExporting, type ExportState } from '../export-archive.js';
import { isHosted, savesTo } from '../app-bridge.js';

/**
 * The export page.
 *
 * Export used to be a bare topbar link, so a click started a possibly multi-gigabyte
 * download with no warning and no account of what was in it. It is the only copy of the
 * library the person holds themselves — the instance's own backups (MAK-171, "Durability"
 * in the README) are the operator's, for a fault on the service's side, and age out — which
 * makes it worth a page that says so.
 *
 * A button rather than a link now: the archive is built here in the browser, a page of
 * notes per request, because one request to the Worker may make only so many calls to
 * the database and a library is far more than that (see `export-archive.ts`). Chrome and
 * Edge ask where to save and stream the zip to that file as it is built; other browsers
 * hold it in memory until it is done and then hand it over as a download.
 */
export function Export() {
  const exporting = useExporting();
  // Whether this instance keeps backups of its own, for the closing paragraph; a fork with
  // none must not be told it has them. Absent reads as none, like the rest of the config.
  const backups = Boolean(useQuery(configQuery()).data?.backups);
  // Matches the filename the export stamps, so the example is never a date from the past.
  const stamp = new Date().toISOString().slice(0, 10);
  const running = exporting.status === 'running';

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Export everything</h2>
      </div>

      <p className="muted small">
        Saves every note as a zip of folders — one per note, with its attachments beside
        it. Plain files, readable without this app or any other.
      </p>

      <pre className="export-tree">
        {`unbent-export-${stamp}.zip
├── meeting-notes-a1b2c3d4/
│   ├── meeting-notes-a1b2c3d4.md    The note, with title, dates, tags and notebook up top
│   └── files/                       Attachments, under their original names
│       └── agenda.pdf
└── notebooks/
    └── work.yaml                    A notebook's fields: their types, options and scales`}
      </pre>

      <p className="muted small">
        Each folder is named for its note plus a few characters of the note&apos;s id. The
        id is not decoration: two notes both called &ldquo;Meeting notes&rdquo; would
        otherwise collide into one folder and the second would overwrite the first. The
        markdown file repeats that name so searching your disk for a note title finds one
        file rather than a thousand called <code>note.md</code>.
      </p>

      <p className="muted small">
        Attachments sit in their own <code>files/</code> folder, which is what the links
        inside the note point at — and what keeps a file you attached from colliding with
        the note&apos;s own markdown.
      </p>

      <p className="muted small">
        A note carries its field values, but not what its fields are — whether one is a
        URL or a select, which options a select offers, how many stars a rating has. That
        lives in <code>notebooks/</code>, one small file per notebook, so a restore brings
        each notebook back as it was rather than as its values suggest.
      </p>

      <p className="muted small">
        Notes in the Trash are not included. Restore anything you want to keep before
        exporting.
      </p>

      <p className="muted small">
        This page exports everything. To export one notebook, use the download beside it
        under <Link to="/settings/notebooks" className="link">Notebooks</Link>. For any
        other slice — a tag, a range of dates — filter the note list, then open the count
        under its heading (<em>37 notes ⌄</em>) and choose <em>Export these notes</em>, or
        select the notes you want and export them from the bar that appears. The archive has
        the same shape either way.
      </p>

      {/* The other half of the promise, said where the first half is made: a backup that
          cannot be put back is a copy, not a backup, and a notebook exported to move it
          somewhere needs the somewhere to take it. */}
      <p className="muted small">
        The zip goes back in through <Link to="/settings/import" className="link">Import</Link>,
        into this Unbent or any other. Notes keep their ids, notebooks, tags, dates and
        fields, and notes that are already there are skipped — so restoring a backup over
        what you have never duplicates anything.
      </p>

      <div className="export-actions">
        {running ? (
          <Button tone="danger" disabled={exporting.stopping} onClick={stopExport}>
            {exporting.stopping ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => startExport({})}>
            {exporting.status === 'done' ? 'Export again' : 'Export everything'}
          </Button>
        )}
        <ExportStatus state={exporting} />
      </div>
      {/* Mounted from the start, so the first thing it says is heard: a live region that
          appears with its first message is often not announced at all. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement(exporting)}
      </span>

      {/* Which of these is true depends on where the bytes go; see `export-archive.ts`. */}
      {isHosted() ? (
        <p className="muted small">
          The archive is built in the app, a few notes at a time, and written to{' '}
          {savesTo() === 'Files' ? 'the Files app' : "your phone's Downloads"} as it goes, so a
          library of any size exports. Keep the app open until it finishes.
        </p>
      ) : (
        <p className="muted small">
          The archive is built in this tab, a few notes at a time. In Chrome and Edge you are
          asked where to save it first and it is written there as it goes, so a library of
          any size exports. Other browsers keep it in memory until it is finished and then
          hand it to your downloads, which is fine for a notebook and may not be for
          everything; if it fails, try a slice at a time, or Chrome.
        </p>
      )}

      {/* Said plainly because the old text here called this "the backup", which stopped
          being the whole truth where the instance keeps copies of its own. Those are not
          the person's to reach, and they age out, so the zip is still the one copy in their
          own hands — the distinction a customer who lost something would care about. */}
      <p className="muted small">
        {backups
          ? 'This is the copy you hold. Unbent keeps backups of its own for putting things right ' +
            'after a fault on our side, but they are not something you can reach and they age ' +
            'out; the zip is the one copy in your own hands, and the only way back from what ' +
            'the trash and a note’s History cannot undo, such as deleting everything.'
          : 'This is the backup. This Unbent makes no backups of its own, so the zip is the ' +
            'only way back from a bad day.'}
      </p>
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * What a screen reader hears of the export: the same story as `ExportStatus`, told in
 * steps. The visible count moves on every note, and a live region that did the same
 * would talk over everything else for as long as the export ran; this changes every
 * tenth of the way. A failure is left to `ExportStatus`'s alert, which is heard at once.
 */
function announcement(state: ExportState): string {
  switch (state.status) {
    case 'idle':
    case 'error':
      return '';
    case 'running': {
      if (state.stopping) return 'Stopping the export.';
      if (!state.total) return 'Exporting.';
      return `Exporting, ${Math.floor((state.done / state.total) * 10) * 10}% done.`;
    }
    case 'done': {
      const skipped = state.skipped > 0 ? ` ${plural(state.skipped, 'file')} could not be found.` : '';
      return `${savedAs(state)}: ${plural(state.done, 'note')} and ${plural(state.files, 'file')}.${skipped}`;
    }
    case 'stopped':
      return 'Export stopped. Nothing was saved.';
  }
}

/**
 * What the export is doing, beside its button: a count that moves while it runs, and
 * where the archive went when it is done. The bar is the count as a fraction, drawn only
 * once the total is known — before that, the count alone is the honest picture.
 *
 * Seen rather than heard: the live region beside it (`announcement`) speaks for it, so
 * none of this is a live region itself. The bar is a real progressbar, for a reader who
 * goes looking.
 */
export function ExportStatus({ state }: { state: ExportState }) {
  switch (state.status) {
    case 'idle':
      return null;
    case 'running':
      return (
        <div className="export-progress">
          {state.total !== null && state.total > 0 && (
            <div
              className="progress-bar"
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={state.total}
              aria-valuenow={state.done}
            >
              <div className="progress-fill" style={{ width: `${(state.done / state.total) * 100}%` }} />
            </div>
          )}
          <span className="muted small">
            {state.total === null
              ? `Exporting… ${plural(state.done, 'note')} so far`
              : `Exporting ${state.done.toLocaleString()} of ${plural(state.total, 'note')}…`}
          </span>
        </div>
      );
    case 'done':
      return (
        <span className="muted small">
          {state.destination === 'download' ? 'Downloaded' : 'Saved'} <code>{state.filename}</code>
          {state.destination === 'app' && ` to ${savesTo()}`}:{' '}
          {plural(state.done, 'note')} and {plural(state.files, 'file')}.
          {state.skipped > 0 &&
            ` ${plural(state.skipped, 'file')} ${state.skipped === 1 ? 'was' : 'were'} gone by the time the export reached ${state.skipped === 1 ? 'it' : 'them'}, so ${state.skipped === 1 ? 'it is' : 'they are'} not in it.`}
        </span>
      );
    case 'stopped':
      return (
        <span className="muted small">
          Stopped. Nothing was saved; export again when you are ready.
        </span>
      );
    case 'error':
      return (
        <span className="bad small" role="alert">
          The export failed: {state.error}. Nothing was saved.
        </span>
      );
  }
}
