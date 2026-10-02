import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { DEFAULT_PAGES_NOTEBOOK, type NotionUnit } from '@unbent/enex';
import {
  getImportRun,
  pickImportFile,
  resetImport,
  startImport,
  stopImport,
  useImportRun,
} from '../import-run.js';
import { Button } from './Button.js';
import { EnexHelp, NotionHelp } from './ImportHelp.js';
import { describeImportFile } from './import-file.js';
import { importPercent } from './import-progress.js';
import { ImportSkips } from './ImportSkips.js';

/** `1 note`, `3,325 notes`. */
function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * The import page: a view of the run in `import-run.ts`, which outlives it.
 *
 * Leaving this page while a run goes, or after one, and coming back shows the same run.
 * What is only the form's — the Notion choices, the PDF checkbox — stays here, since it
 * means nothing once a run has started.
 */
export function Import() {
  const { status, file, zip, progress, failures, skips, error, startedAt, endedAt, run } = useImportRun();
  const [extractText, setExtractText] = useState(true);
  /** The Notion units to import, by key; every non-empty one until the person unticks it. */
  const [include, setInclude] = useState<ReadonlySet<string>>(new Set());
  const [pagesNotebook, setPagesNotebook] = useState(DEFAULT_PAGES_NOTEBOOK);
  const [tagsAsTags, setTagsAsTags] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // Everything importable starts ticked, each time a zip is read.
  useEffect(() => {
    setInclude(new Set(zip?.kind === 'notion' ? zip.units.filter((u) => !u.empty).map((u) => u.key) : []));
  }, [zip]);

  /*
   * A file picked and not started is dropped on leaving. The run is worth keeping; a
   * pick is not, and the file input cannot be given it back — so returning would show
   * "No file chosen" above a line naming the file, with Start enabled.
   */
  useEffect(() => {
    return () => {
      if (getImportRun().status === 'idle') pickImportFile(null);
    };
  }, []);

  // A long import needs a clock; without one a slow file is indistinguishable from a hang.
  useEffect(() => {
    if (status !== 'running') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  const elapsed = status === 'idle' ? 0 : Math.max(0, (endedAt ?? now) - startedAt);

  // What the picked file is, and so whether Start does anything. Null until one is picked.
  const picked = file ? describeImportFile(file.name, zip && zip.kind !== 'unreadable' ? zip.kind : 'reading') : null;

  /**
   * Whether Start does anything: a file an importer takes, and for a zip, one the worker
   * has read — this app's own, or Notion's with at least one unit ticked.
   */
  const canStart =
    picked !== null &&
    picked.format !== null &&
    (picked.format !== 'zip' ||
      (zip !== null && zip.kind !== 'unreadable' && (zip.kind === 'unbent' || include.size > 0)));

  function start() {
    if (!canStart) return;
    startImport({
      extractText,
      ...(zip?.kind === 'notion' ? { notion: { include: [...include], pagesNotebook, tagsAsTags } } : {}),
    });
  }

  /*
   * "Import another file" and "Try another file" are the only way a run is forgotten.
   *
   * The summary stays until one is pressed. A small import finishes in well under a
   * second, and previously the only way back to the file picker was closing and reopening
   * the panel — which threw away the result before it could be read.
   */
  function reset() {
    resetImport();
  }

  const pct = importPercent(progress, file?.size ?? 0, status === 'done');

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Import</h2>
      </div>

      {status === 'idle' && (
        <>
          <p className="muted small">
            Bring notes in from Evernote, from Notion, or from another Unbent. Notes that are
            already here are skipped, so an interrupted run is safe to repeat and a backup can
            be restored over what you have.
          </p>

          {/* One line per file kind, because the one thing that differs between them is
              worth knowing before choosing: an .enex file's name becomes the notebook, an
              archive's is ignored because every note inside names its own. */}
          <ul className="import-formats small">
            <li>
              <code>.enex</code> — an Evernote export. The file name becomes each note&apos;s
              notebook, so notebooks survive the move.
            </li>
            <li>
              <code>.zip</code> or <code>.md</code> — an Unbent export, from this app or any
              other. Each note keeps its notebook, tags, dates, fields and files.
            </li>
            <li>
              <code>.zip</code> from Notion — a Markdown &amp; CSV export. Pick the databases and
              pages to bring in; each becomes a notebook, with a database&apos;s columns as its
              fields.
            </li>
          </ul>

          {/* Reading happens here in the browser, not on the server: a multi-GB file is
              minutes of local CPU with no server-side progress to fall back on. Saying so
              up front is what stops a slow import reading as a hung one. */}
          <p className="muted small">
            Large files are read on this machine, so a multi-gigabyte export can take
            several minutes and the tab needs to stay open. If it does get interrupted, start
            the same file again — nothing duplicates.
          </p>

          <EnexHelp />
          <NotionHelp />

          <input
            type="file"
            accept=".enex,.zip,.md,application/xml,text/xml,application/zip,text/markdown"
            onChange={(e) => pickImportFile(e.target.files?.[0] ?? null)}
          />

          {file && picked && (
            <p className="import-file small">
              <span>
                {file.name} · {formatBytes(file.size)}
              </span>
              {/* Says what the run will do with this file — or why it will not start. */}
              <span className={picked.format === null || zip?.kind === 'unreadable' ? 'bad' : 'muted'}>
                {zip?.kind === 'unreadable' ? zip.message : picked.text}
              </span>
            </p>
          )}

          {zip?.kind === 'notion' && (
            <NotionPicker
              units={zip.units}
              include={include}
              onInclude={setInclude}
              pagesNotebook={pagesNotebook}
              onPagesNotebook={setPagesNotebook}
              tagsAsTags={tagsAsTags}
              onTagsAsTags={setTagsAsTags}
            />
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={extractText}
              onChange={(e) => setExtractText(e.target.checked)}
            />
            <span className="small">
              Search inside PDFs — reads the text already embedded in scanned attachments,
              by Evernote&apos;s OCR or a scanner&apos;s. Most scanned notes have no body
              text, so without this they are only findable by title. Adds roughly a second
              per PDF.
            </span>
          </label>

          <Button variant="primary" disabled={!canStart} onClick={start}>
            Start import
          </Button>

          {/* The other half of the checkbox above: extract now, or catch up later. The
              catching up lives with the account's other housekeeping, not here. */}
          <p className="muted small">
            Files already here that search cannot read yet are indexed from{' '}
            <Link to="/settings/maintenance" className="link">
              Maintenance
            </Link>
            .
          </p>
        </>
      )}

      {(status === 'running' || status === 'done' || status === 'error') && progress && (
        <>
          <div className="progress-bar" aria-label="import progress">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>

          <dl className="import-stats">
            <div>
              <dt>Imported</dt>
              <dd>{progress.created.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Skipped</dt>
              <dd>{progress.skipped.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{progress.filesUploaded.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Indexed</dt>
              <dd>{progress.filesIndexed.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Failed</dt>
              <dd className={progress.failed > 0 ? 'bad' : undefined}>
                {progress.failed.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Read</dt>
              <dd>{formatBytes(progress.bytesRead)}</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd>{Math.floor(elapsed / 1000)}s</dd>
            </div>
          </dl>

          {status === 'running' && (
            <>
              <p className="muted small truncate">{progress.currentTitle}</p>
              <Button variant="secondary" tone="danger" onClick={stopImport}>
                Stop
              </Button>
            </>
          )}
        </>
      )}

      {status === 'done' && (
        <div className="import-finished">
          <p className="good small">
            Finished in {Math.max(1, Math.round(elapsed / 1000))}s.{' '}
            {count(progress?.created ?? 0, 'note')} imported
            {/* Told apart because they are not the same news: a duplicate inside the file
                is the export repeating itself, one already here is a resume working. */}
            {skips.duplicateCount > 0
              ? `, ${count(skips.duplicateCount, 'duplicate')} skipped`
              : ''}
            {skips.presentCount > 0
              ? `, ${skips.presentCount.toLocaleString()} already present`
              : ''}
            {progress && progress.filesUploaded > 0
              ? `, ${count(progress.filesUploaded, 'file')}`
              : ''}
            .
          </p>
          <Button variant="secondary" onClick={reset}>
            Import another file
          </Button>
        </div>
      )}

      {status === 'error' && (
        <div className="import-finished">
          <p className="bad small">{error}</p>
          <Button variant="secondary" onClick={reset}>
            Try another file
          </Button>
        </div>
      )}

      {failures.length > 0 && (
        <details className="failures">
          {/* Not "notes failed": a notebook's definitions the server would not take, or one
              field of them it declined, are listed here too, under the notebook's or the
              field's name — see `ImportRun.problem`. */}
          <summary className="small">{failures.length} failed</summary>
          {/* The retry is free — importNote is idempotent per note — but nothing said so,
              so a run ending with failures looked like data lost rather than data to retry. */}
          <p className="small muted">
            Importing the same file again retries just these; everything that already landed
            is skipped.
          </p>
          <ul className="small">
            {failures.map((f, i) => (
              <li key={i}>
                <strong>{f.title}</strong> — {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <ImportSkips log={skips} run={run} />
    </div>
  );
}

interface NotionPickerProps {
  units: NotionUnit[];
  include: ReadonlySet<string>;
  onInclude: (next: ReadonlySet<string>) => void;
  pagesNotebook: string;
  onPagesNotebook: (name: string) => void;
  tagsAsTags: boolean;
  onTagsAsTags: (on: boolean) => void;
}

/** How a unit's kind reads in the list. */
function unitKind(unit: NotionUnit): string {
  switch (unit.kind) {
    case 'database':
      return 'Database';
    case 'page':
      return 'Page and its sub-pages';
    case 'pages':
      return 'Pages outside any database';
  }
}

/**
 * What a Notion export holds, one row per top-level database or page, each to tick or not.
 *
 * The export is read before Start so the list is real: its counts are the notes and files
 * that would land, and a database whose rows never made it into the zip is shown and
 * greyed rather than silently absent, since "where did my Library go" is the question a
 * missing row would leave. Everything importable starts ticked — the common case is the
 * whole workspace — and All and None are one click each for the rest.
 *
 * The two choices under the list are the two things the importer cannot decide alone:
 * where pages that belong to no database go, and whether a column called Tags is the
 * note's tags or a field of its own.
 */
function NotionPicker({
  units,
  include,
  onInclude,
  pagesNotebook,
  onPagesNotebook,
  tagsAsTags,
  onTagsAsTags,
}: NotionPickerProps) {
  const importable = units.filter((u) => !u.empty);
  const chosen = importable.filter((u) => include.has(u.key));
  const notes = chosen.reduce((n, u) => n + u.notes, 0);
  const files = chosen.reduce((n, u) => n + u.attachments, 0);

  const toggle = (key: string, on: boolean) => {
    const next = new Set(include);
    if (on) next.add(key);
    else next.delete(key);
    onInclude(next);
  };

  return (
    <div className="notion-picker">
      <p className="notion-picker-head small">
        <span className="muted">
          {chosen.length} of {importable.length} chosen: {count(notes, 'note')}
          {files > 0 ? `, ${count(files, 'file')}` : ''}.
        </span>
        <button type="button" className="link" onClick={() => onInclude(new Set(importable.map((u) => u.key)))}>
          All
        </button>
        <button type="button" className="link" onClick={() => onInclude(new Set())}>
          None
        </button>
      </p>
      <ul className="notion-units">
        {units.map((u) => (
          <li key={u.key}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                disabled={u.empty}
                checked={!u.empty && include.has(u.key)}
                onChange={(e) => toggle(u.key, e.target.checked)}
              />
              <span className="notion-unit">
                <span className="notion-unit-name">{u.name}</span>
                <span className="small">
                  {u.empty
                    ? 'Empty in the export: nothing to import.'
                    : [
                        unitKind(u),
                        count(u.notes, 'note'),
                        ...(u.attachments > 0 ? [count(u.attachments, 'file')] : []),
                        ...(u.fields > 0 ? [count(u.fields, 'field')] : []),
                      ].join(' · ')}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {importable.some((u) => u.kind === 'pages') && include.has('pages') && (
        <label className="notion-pages-notebook small">
          <span className="muted">Notebook for the pages outside any database</span>
          <input
            className="search-field"
            value={pagesNotebook}
            placeholder="Leave empty to file them in none"
            aria-label="Notebook for the pages outside any database"
            onChange={(e) => onPagesNotebook(e.target.value)}
          />
        </label>
      )}
      <label className="checkbox-row">
        <input type="checkbox" checked={tagsAsTags} onChange={(e) => onTagsAsTags(e.target.checked)} />
        <span className="small">
          A column named Tags becomes the note&apos;s tags. Untick to keep it as a field of the
          notebook instead.
        </span>
      </label>
    </div>
  );
}
