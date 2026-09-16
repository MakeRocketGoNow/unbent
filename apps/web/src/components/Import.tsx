import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportFailure, ImportProgress } from '@unbent/enex';
import type { ImportEvent, ImportRequest } from '../import-worker.js';
import { startIndexing, useIndexing, type IndexingState } from '../index-files.js';
import { Button } from './Button.js';
import { describeImportFile } from './import-file.js';
import { ImportSkips } from './ImportSkips.js';
import { emptySkipLog, recordSkip, type SkipLog } from './import-skips.js';
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

/**
 * One line under the button. The app may have run a pass on its own before this panel was
 * opened, so every state the store can be in has a sentence here, not only the ones the
 * button itself leads to.
 */
function indexingText(state: IndexingState): string {
  const p = state.progress;
  switch (state.status) {
    case 'idle':
      return 'For notes imported before PDF search existed.';
    case 'running':
      return `Indexing… ${p?.done ?? 0}${p?.total ? ` / ${p.total}` : ''}`;
    case 'done':
      return (
        `Done. Indexed ${p?.indexed ?? 0} of ${p?.done ?? 0} PDFs.` +
        (p?.failed ? ` ${p.failed} could not be read and will be tried again.` : '')
      );
    case 'deferred':
      return `${state.remaining} PDFs are not searchable yet.`;
    case 'error':
      return state.error ?? 'Indexing failed.';
  }
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
  const indexing = useIndexing();

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
  const picked = file ? describeImportFile(file.name) : null;

  const start = useCallback(() => {
    if (!file || describeImportFile(file.name).format === null) return;

    setStatus('running');
    setFailures([]);
    setSkips(emptySkipLog);
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
      if (data.type === 'progress') {
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
    setSkips(emptySkipLog);
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
        <h2>Import</h2>
      </div>

      {status === 'idle' && (
        <>
          <p className="muted small">
            Bring notes in from Evernote, or from another Unbent. Notes that are already here
            are skipped, so an interrupted run is safe to repeat and a backup can be restored
            over what you have.
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

          <input
            type="file"
            accept=".enex,.zip,.md,application/xml,text/xml,application/zip,text/markdown"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          {file && picked && (
            <p className="import-file small">
              <span>
                {file.name} · {formatBytes(file.size)}
              </span>
              {/* Says what the run will do with this file — or why it will not start. */}
              <span className={picked.format === null ? 'bad' : 'muted'}>{picked.text}</span>
            </p>
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

          <Button variant="primary" disabled={!picked || picked.format === null} onClick={start}>
            Start import
          </Button>
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
                is a note that did not come through, one already here is a resume working. */}
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

      {status === 'idle' && (
        <div className="backfill-row">
          <Button size="small" disabled={indexing.status === 'running'} onClick={() => startIndexing({ auto: false })}>
            Index existing PDFs
          </Button>
          <span className={indexing.status === 'error' ? 'bad small' : 'muted small'}>
            {indexingText(indexing)}
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

      <ImportSkips log={skips} />
    </div>
  );
}
