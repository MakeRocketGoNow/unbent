import { useState } from 'react';
import { Link } from '@tanstack/react-router';

/**
 * The export page.
 *
 * Export used to be a bare topbar link, so a click started a possibly multi-gigabyte
 * download with no warning and no account of what was in it. It is the only backup this
 * app has, which makes it worth a page that says so.
 *
 * Still an anchor rather than a button: the archive is generated as it downloads, and
 * letting the browser consume the response is what keeps a corpus larger than the
 * Worker's 128MB ceiling from ever landing in a JS buffer. An anchor also keeps
 * Save-Link-As, copy-link and middle-click, and works even if the bundle has failed.
 */
export function Export() {
  const [started, setStarted] = useState(false);
  // Matches the filename the API stamps, so the example is never a date from the past.
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Export everything</h2>
      </div>

      <p className="muted small">
        Downloads every note as a zip of folders — one per note, with its attachments
        beside it. Plain files, readable without this app or any other.
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
        other slice — a tag, a range of dates — filter the note list and use{' '}
        <em>Export these notes</em> beneath the filters. The archive has the same shape
        either way.
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

      <a className="primary export-button" href="/api/export" download onClick={() => setStarted(true)}>
        {started ? 'Download again' : 'Download export'}
      </a>

      {started && (
        <p className="muted small">
          The download is running in your browser. A large library takes a few minutes and
          will not show a percentage — the archive is built as it downloads, so its final
          size is not known when it starts. If it stops early the zip will not open; just
          download it again, since exporting changes nothing on the server.
        </p>
      )}

      <p className="muted small">
        This is the backup. D1&apos;s own export cannot be used — it fails on any database
        with a full-text search index and leaves the database wedged — so a copy of this
        zip is the only way back from a bad day.
      </p>
    </div>
  );
}
