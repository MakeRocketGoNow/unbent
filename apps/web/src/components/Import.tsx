import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportFailure, ImportProgress } from '@unbent/enex';
import type { ImportEvent, ImportRequest } from '../import-worker.js';

interface ImportProps {
  onClose: () => void;
  /** Called when notes actually landed, so the list can refresh. */
  onImported: () => void;
}

type Status = 'idle' | 'running' | 'done' | 'error';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function Import({ onClose, onImported }: ImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [failures, setFailures] = useState<ImportFailure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const worker = useRef<Worker | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    return () => worker.current?.terminate();
  }, []);

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
    setProgress(null);
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
      } else if (data.type === 'done') {
        setProgress(data.progress);
        setStatus('done');
        onImported();
        w.terminate();
        worker.current = null;
      } else {
        setError(data.message);
        setStatus('error');
        onImported();
        w.terminate();
        worker.current = null;
      }
    };

    w.onerror = (event) => {
      setError(event.message || 'Import worker failed');
      setStatus('error');
    };

    const request: ImportRequest = { type: 'start', file };
    w.postMessage(request);
  }, [file, onImported]);

  function stop() {
    worker.current?.postMessage({ type: 'abort' } satisfies ImportRequest);
  }

  const pct =
    file && progress && file.size > 0
      ? Math.min(100, Math.round((progress.bytesRead / file.size) * 100))
      : 0;

  return (
    <div className="import-panel">
      <div className="import-head">
        <h2>Import from Evernote</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>

      {status === 'idle' && (
        <>
          <p className="muted small">
            Select one <code>.enex</code> file. Notes are tagged with the file name so
            notebooks survive the move. Re-running an import skips notes that already
            landed, so an interrupted run is safe to repeat.
          </p>

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
        <p className="good small">
          Finished. {progress?.created.toLocaleString()} notes imported
          {progress && progress.skipped > 0
            ? `, ${progress.skipped.toLocaleString()} already present`
            : ''}
          .
        </p>
      )}

      {status === 'error' && <p className="bad small">{error}</p>}

      {failures.length > 0 && (
        <details className="failures">
          <summary className="small">
            {failures.length} note{failures.length === 1 ? '' : 's'} failed
          </summary>
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
