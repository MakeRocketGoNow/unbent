import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  DEFAULT_PAGES_NOTEBOOK,
  importFormat,
  type ImportFailure,
  type ImportProgress,
  type NotionUnit,
} from '@unbent/enex';
import type { ImportEvent, ImportRequest, NotionChoices } from '../import-worker.js';
import { Button } from './Button.js';
import { describeImportFile } from './import-file.js';
import { importPercent } from './import-progress.js';
import { ImportSkips } from './ImportSkips.js';
import { emptySkipLog, recordSkip, type SkipLog } from './import-skips.js';
import { useSettingsBusy } from './SettingsLayout.js';

interface ImportProps {
  /** Called when notes actually landed, so the list can refresh. */
  onImported: () => void;
}

type Status = 'idle' | 'running' | 'done' | 'error';

/** What the worker said a picked zip is: this app's own export, Notion's, or neither. */
type ZipDescription =
  | { kind: 'unbent' }
  | { kind: 'notion'; units: NotionUnit[] }
  | { kind: 'unreadable'; message: string };

function initialProgress(): ImportProgress {
  return {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    notesTotal: 0,
    currentTitle: 'Starting import…',
  };
}

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

export function Import({ onImported }: ImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [failures, setFailures] = useState<ImportFailure[]>([]);
  const [skips, setSkips] = useState<SkipLog>(emptySkipLog);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [extractText, setExtractText] = useState(true);
  const [zip, setZip] = useState<ZipDescription | null>(null);
  /** The Notion units to import, by key; every non-empty one until the person unticks it. */
  const [include, setInclude] = useState<ReadonlySet<string>>(new Set());
  const [pagesNotebook, setPagesNotebook] = useState(DEFAULT_PAGES_NOTEBOOK);
  const [tagsAsTags, setTagsAsTags] = useState(true);

  const { setImportRunning } = useSettingsBusy();
  const worker = useRef<Worker | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    return () => worker.current?.terminate();
  }, []);

  // Mirrored into the section rather than set at each transition: the sub-nav has to go
  // inert for the whole run, and there are five places status changes.
  useEffect(() => {
    setImportRunning(status === 'running');
    return () => setImportRunning(false);
  }, [status, setImportRunning]);

  // A long import needs a clock; without one a slow file is indistinguishable from a hang.
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 1000);
    return () => clearInterval(timer);
  }, [status]);

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

  /**
   * The worker, made on first need and kept until the panel unmounts.
   *
   * It used to be made at Start and thrown away when the run ended. A zip is described
   * before Start — the panel has to know whether it is Notion's to draw the picker — so it
   * is made at whichever comes first, and a run's end leaves it for the next file.
   */
  const spawn = useCallback((): Worker => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL('../import-worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;

    w.onmessage = (event: MessageEvent<ImportEvent>) => {
      const data = event.data;
      if (data.type === 'described') {
        if (data.kind === 'notion') {
          setZip({ kind: 'notion', units: data.units });
          setInclude(new Set(data.units.filter((u) => !u.empty).map((u) => u.key)));
        } else if (data.kind === 'unbent') {
          setZip({ kind: 'unbent' });
        } else {
          setZip({ kind: 'unreadable', message: data.message });
        }
      } else if (data.type === 'progress') {
        setProgress(data.progress);
      } else if (data.type === 'failure') {
        // Cap the retained list: a bad file could otherwise produce thousands of entries
        // and push the tab into swap.
        setFailures((prev) => (prev.length >= 200 ? prev : [...prev, data.failure]));
      } else if (data.type === 'skip') {
        setSkips((prev) => recordSkip(prev, data.skip));
      } else if (data.type === 'done') {
        setProgress(data.progress);
        setStatus('done');
        onImported();
      } else if (data.type === 'error') {
        setError(data.message);
        setStatus('error');
        onImported();
      }
    };

    w.onerror = (event) => {
      // Module workers often report an empty message on abrupt death (e.g. nested pdf.js
      // worker teardown). Surface something actionable rather than a blank error line.
      setError(event.message || 'Import worker crashed — try again; already-imported notes are skipped.');
      setStatus('error');
      w.terminate();
      worker.current = null;
    };
    return w;
  }, [onImported]);

  /** Takes a file and, for a zip, has the worker read it so the panel can say what it is. */
  function pick(next: File | null) {
    setFile(next);
    setZip(null);
    setInclude(new Set());
    setError(null);
    if (next && importFormat(next.name) === 'zip') {
      spawn().postMessage({ type: 'describe', file: next } satisfies ImportRequest);
    }
  }

  const start = useCallback(() => {
    if (!file || !canStart) return;

    setStatus('running');
    setFailures([]);
    setSkips(emptySkipLog);
    setError(null);
    // Show the running state before the worker module finishes loading. This also keeps a
    // worker startup failure visible instead of leaving the user on an unchanged form.
    setProgress(initialProgress());
    startedAt.current = Date.now();
    setElapsed(0);

    const choices: NotionChoices | undefined =
      zip?.kind === 'notion' ? { include: [...include], pagesNotebook, tagsAsTags } : undefined;
    const request: ImportRequest = { type: 'start', file, extractText, ...(choices ? { notion: choices } : {}) };
    spawn().postMessage(request);
  }, [file, canStart, extractText, zip, include, pagesNotebook, tagsAsTags, spawn]);

  function stop() {
    worker.current?.postMessage({ type: 'abort' } satisfies ImportRequest);
  }

  /**
   * Clears a finished run so another file can be picked.
   *
   * The summary stays on screen until this is pressed. A small import finishes in well
   * under a second, and previously the only way back to the file picker was closing and
   * reopening the panel — which threw away the result before it could be read.
   */
  function reset() {
    setFile(null);
    setZip(null);
    setInclude(new Set());
    setProgress(null);
    setFailures([]);
    setSkips(emptySkipLog);
    setError(null);
    setElapsed(0);
    setStatus('idle');
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

          {/* Evernote has no export API, so the .enex has to be produced by hand before
              this page is any use at all. Someone arriving here without one has nowhere
              to go, which made the whole feature undiscoverable for the person it is for. */}
          <details className="enex-help">
            <summary className="small">How do I get an .enex file?</summary>
            <div className="small">
              <p>
                <strong>From Evernote desktop.</strong> Select the notes or a notebook, then
                File → Export notes. Choose ENEX. The desktop app is the only place Evernote
                offers this; the web client cannot.
              </p>
              <p>
                <strong>For a whole account.</strong> Exporting tens of thousands of notes by
                hand is unreliable, and the desktop app tends to give up partway.{' '}
                <a
                  href="https://github.com/vzhd1701/evernote-backup"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="link"
                >
                  evernote-backup
                </a>{' '}
                syncs the account and writes one .enex per notebook. Import them one at a
                time here.
              </p>
            </div>
          </details>

          {/* Notion has no export API either, and its export lives three menus deep. */}
          <details className="enex-help">
            <summary className="small">How do I export from Notion?</summary>
            <div className="small">
              <p>
                <strong>The whole workspace.</strong> Settings → Settings → Export content → Export
                all workspace content. Choose Markdown &amp; CSV, and include subpages. Notion emails
                a link to the zip.
              </p>
              <p>
                <strong>One database or page.</strong> Open it, then ··· → Export, with the same
                choices. The zip imports the same way; it just holds less.
              </p>
            </div>
          </details>

          <input
            type="file"
            accept=".enex,.zip,.md,application/xml,text/xml,application/zip,text/markdown"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
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
              <Button variant="secondary" tone="danger" onClick={stop}>
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

      <ImportSkips log={skips} />
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
