import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportFailure, ImportProgress } from '@unbent/enex';
import type { BackfillProgress, ImportEvent, ImportRequest } from '../import-worker.js';
import { useSettingsBusy } from './SettingsLayout.js';

interface ImportProps {
  /** Called when notes actually landed, so the list can refresh. */
  onImported: () => void;
}

type Status = 'idle' | 'running' | 'done' | 'error';

function initialProgress(): ImportProgress {
  return {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    currentTitle: 'Starting import…',
  };
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
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [extractText, setExtractText] = useState(true);
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  const [backfillDone, setBackfillDone] = useState(false);

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

  const start = useCallback(() => {
    if (!file) return;

    setStatus('running');
    setFailures([]);
    setError(null);
    // Show the running state before the worker module finishes loading. This also keeps a
    // worker startup failure visible instead of leaving the user on an unchanged form.
    setProgress(initialProgress());
    startedAt.current = Date.now();
    setElapsed(0);

    const w = new Worker(new URL('../import-worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;

    w.onmessage = (event: MessageEvent<ImportEvent>) => {
      const data = event.data;
      if (data.type === 'backfill-progress') {
        setBackfill(data.progress);
      } else if (data.type === 'backfill-done') {
        setBackfill(data.progress);
        setBackfillDone(true);
        setStatus('idle');
        onImported();
        w.terminate();
        worker.current = null;
      } else if (data.type === 'progress') {
        setProgress(data.progress);
      } else if (data.type === 'failure') {
        // Cap the retained list: a bad file could otherwise produce thousands of entries
        // and push the tab into swap.
        setFailures((prev) => (prev.length >= 200 ? prev : [...prev, data.failure]));
      } else if (data.type === 'done') {
        setProgress(data.progress);
        setStatus('done');
        onImported();
        w.terminate();
        worker.current = null;
      } else if (data.type === 'error') {
        setError(data.message);
        setStatus('error');
        onImported();
        w.terminate();
        worker.current = null;
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

    const request: ImportRequest = { type: 'start', file, extractText };
    w.postMessage(request);
  }, [file, extractText, onImported]);

  const startBackfill = useCallback(() => {
    setBackfill({ done: 0, indexed: 0, total: 0 });
    setBackfillDone(false);
    setError(null);

    const w = new Worker(new URL('../import-worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;

    w.onmessage = (event: MessageEvent<ImportEvent>) => {
      const data = event.data;
      if (data.type === 'backfill-progress') {
        setBackfill(data.progress);
      } else if (data.type === 'backfill-done') {
        setBackfill(data.progress);
        setBackfillDone(true);
        onImported();
        w.terminate();
        worker.current = null;
      } else if (data.type === 'error') {
        setError(data.message);
        w.terminate();
        worker.current = null;
      }
    };

    w.postMessage({ type: 'backfill' } satisfies ImportRequest);
  }, [onImported]);

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
    setProgress(null);
    setFailures([]);
    setError(null);
    setElapsed(0);
    setStatus('idle');
  }

  /**
   * Progress bar fill.
   *
   * Pinned to 100% once the run finishes: the last bytes are read before the final notes
   * finish uploading, so a byte-based bar can otherwise sit at 99% on a completed import
   * and read as stalled.
   */
  const pct =
    status === 'done'
      ? 100
      : file && progress && file.size > 0
        ? Math.min(100, Math.round((progress.bytesRead / file.size) * 100))
        : 0;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Import from Evernote</h2>
      </div>

      {status === 'idle' && (
        <>
          <p className="muted small">
            Select one <code>.enex</code> file. The file name becomes each note&apos;s
            notebook so notebooks survive the move. Re-running an import skips notes that already
            landed, so an interrupted run is safe to repeat.
          </p>

          {/* Parsing happens here in the browser, not on the server: a multi-GB file is
              minutes of local CPU with no server-side progress to fall back on. Saying so
              up front is what stops a slow import reading as a hung one. */}
          <p className="muted small">
            Large files are parsed on this machine, so a multi-gigabyte export can take
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

          <input
            type="file"
            accept=".enex,application/xml,text/xml"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          {file && (
            <p className="small">
              {file.name} · {formatBytes(file.size)}
            </p>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={extractText}
              onChange={(e) => setExtractText(e.target.checked)}
            />
            <span className="small">
              Search inside PDFs — reads the text Evernote already OCR'd into scanned
              attachments. Most scanned notes have no body text, so without this they are
              only findable by title. Adds roughly a second per PDF.
            </span>
          </label>

          <button type="button" className="primary" disabled={!file} onClick={start}>
            Start import
          </button>
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
              <button type="button" className="link danger" onClick={stop}>
                Stop
              </button>
            </>
          )}
        </>
      )}

      {status === 'done' && (
        <div className="import-finished">
          <p className="good small">
            Finished in {Math.max(1, Math.round(elapsed / 1000))}s.{' '}
            {progress?.created.toLocaleString()} notes imported
            {progress && progress.skipped > 0
              ? `, ${progress.skipped.toLocaleString()} already present`
              : ''}
            {progress && progress.filesUploaded > 0
              ? `, ${progress.filesUploaded.toLocaleString()} files`
              : ''}
            .
          </p>
          <button type="button" className="link" onClick={reset}>
            Import another file
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="import-finished">
          <p className="bad small">{error}</p>
          <button type="button" className="link" onClick={reset}>
            Try another file
          </button>
        </div>
      )}

      {status === 'idle' && (
        <div className="backfill-row">
          <button
            type="button"
            className="link"
            disabled={backfill !== null && !backfillDone}
            onClick={startBackfill}
          >
            Index existing PDFs
          </button>
          <span className="muted small">
            {backfill === null
              ? 'For notes imported before PDF search existed.'
              : backfillDone
                ? `Done. Indexed ${backfill.indexed} of ${backfill.done} PDFs.`
                : `Indexing… ${backfill.done}${backfill.total ? ` / ${backfill.total}` : ''}`}
          </span>
        </div>
      )}

      {failures.length > 0 && (
        <details className="failures">
          <summary className="small">
            {failures.length} note{failures.length === 1 ? '' : 's'} failed
          </summary>
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
    </div>
  );
}
