import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { EnexHelp, JoplinHelp, NotionHelp } from './ImportHelp.js';
import { describeImportFile } from './import-file.js';
import { importPercent } from './import-progress.js';
import { formatBytes } from '../format-bytes.js';
import { ImportSkips } from './ImportSkips.js';
import { usePlan, READ_ONLY_TIP } from '../use-plan.js';
import { isNoteFile, notesFromFiles, resetFileNotes, undoFileNotes, useFileNotes } from '../file-notes.js';
import { NotebookPicker } from './FilingRows.js';
import { notebooksQuery } from '../queries.js';

/** `1 note`, `3,325 notes`. */
function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The import page: a view of the run in `import-run.ts`, which outlives it.
 *
 * Leaving this page while a run goes, or after one, and coming back shows the same run.
 * What is only the form's (the Notion choices, the PDF checkbox) stays here, since it
 * means nothing once a run has started.
 */
export function Import() {
  const { inactive: planInactive } = usePlan();
  const { status, file, zip, progress, failures, skips, error, startedAt, endedAt, run } = useImportRun();
  const [extractText, setExtractText] = useState(true);
  /*
   * PDFs and images picked here, one note each (`file-notes.ts`). The picker is the way
   * in for a phone, where nothing can be dragged onto the list, and for anyone who looks
   * for "import" before trying a drop. A pick is either one export or any number of
   * files for notes, never both; `batchProblem` is the line for a pick that is neither.
   */
  const [batch, setBatch] = useState<File[]>([]);
  const [batchProblem, setBatchProblem] = useState<string | null>(null);
  const [batchNotebook, setBatchNotebook] = useState<string | null>(null);
  const notebooks = useQuery(notebooksQuery());
  /** Remounts the picker once a batch starts: a file input keeps naming the files it was handed. */
  const [pickerKey, setPickerKey] = useState(0);
  const fileNotes = useFileNotes();
  const queryClient = useQueryClient();
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
   * pick is not, and the file input cannot be given it back, so returning would show
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
   * has read (this app's own, or Notion's with at least one unit ticked).
   */
  const canStart =
    picked !== null &&
    picked.format !== null &&
    (picked.format !== 'zip' ||
      (zip !== null && zip.kind !== 'unreadable' && (zip.kind === 'unbent' || include.size > 0)));

  function pick(files: File[]) {
    setBatchProblem(null);
    if (files.length > 0 && files.every(isNoteFile)) {
      pickImportFile(null);
      setBatch(files);
      return;
    }
    setBatch([]);
    if (files.length > 1) {
      // Two exports at once is not a thing either importer does, and a mix of an export
      // and a scan is two different jobs: said here rather than guessed at.
      pickImportFile(null);
      setBatchProblem('Choose one export at a time, or any number of PDFs and images.');
      return;
    }
    pickImportFile(files[0] ?? null);
  }

  function startBatch() {
    if (batch.length === 0 || planInactive) return;
    const notebook = batchNotebook;
    void notesFromFiles(batch, { notebook, tags: [] }, notebook, 'import', queryClient);
    setBatch([]);
    setPickerKey((k) => k + 1);
  }

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
   * the panel, which threw away the result before it could be read.
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

      {/* A batch of notes from files started on this page, drawn where it was started:
          the snackbar that reports it everywhere else stands down here for it
          (`FileNotesSnackbar`). A batch from a drop on the list keeps its card, and is
          not drawn here: it was not started here, and it would sit above the picker
          until something cleared it. Running, a bar; finished, the count and the way to
          the notes. */}
      {fileNotes.source === 'import' && fileNotes.status === 'running' && (
        <div className="import-batch-run">
          <div className="progress-bar" aria-label="notes added">
            <div className="progress-fill" style={{ width: `${Math.round((fileNotes.done / Math.max(1, fileNotes.total)) * 100)}%` }} />
          </div>
          <p className="muted small">
            Adding {count(fileNotes.total, 'note')} · {fileNotes.done} of {fileNotes.total}
          </p>
        </div>
      )}
      {fileNotes.source === 'import' && (fileNotes.status === 'done' || fileNotes.status === 'error') && (
        <div className="import-finished">
          {fileNotes.status === 'done' ? (
            <p className="good small">
              {count(fileNotes.ids.length, 'note')} added{fileNotes.place ? ` to ${fileNotes.place}` : ''}.
            </p>
          ) : (
            <p className="bad small">{fileNotes.error}</p>
          )}
          <span className="import-batch-actions">
            {/* A link wearing the button's shape, since it navigates: it middle-clicks and
                opens in a new tab, which a button that called `navigate` could not. */}
            {fileNotes.ids.length > 0 && (
              <Link
                to="/notes"
                search={fileNotes.filing.notebook ? { notebook: fileNotes.filing.notebook } : {}}
                className="btn btn-secondary"
                // Only a plain click ends the report: a modified one opens the list in a
                // new tab, and the tab left behind keeps its result and its Undo.
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey && !e.shiftKey) resetFileNotes();
                }}
              >
                Show them
              </Link>
            )}
            <Button variant="secondary" onClick={resetFileNotes}>
              Add more files
            </Button>
            {/* The same Undo the card offers elsewhere: twelve scans filed in the wrong
                notebook from here had no way back but finding them one by one. */}
            {fileNotes.ids.length > 0 && (
              <Button variant="quiet" tone="danger" onClick={() => void undoFileNotes(queryClient)}>
                Undo
              </Button>
            )}
          </span>
        </div>
      )}

      {status === 'idle' && (
        <>
          <p className="muted small">
            Bring notes in from Evernote, Notion or Joplin, or from another Unbent. Notes that are
            already here are skipped, so an interrupted run is safe to repeat and a backup can
            be restored over what you have.
          </p>

          {/* One line per file kind, because the one thing that differs between them is
              worth knowing before choosing: an .enex file's name becomes the notebook, an
              archive's is ignored because every note inside names its own. */}
          <ul className="import-formats small">
            <li>
              <code>.enex</code>: an Evernote export. The file name becomes each note&apos;s
              notebook, so notebooks survive the move.
            </li>
            <li>
              <code>.zip</code> or <code>.md</code>: an Unbent export, from this app or any
              other. Each note keeps its notebook, tags, dates, fields and files.
            </li>
            <li>
              <code>.zip</code> from Notion: a Markdown &amp; CSV export. Pick the databases and
              pages to bring in; each becomes a notebook, with a database&apos;s columns as its
              fields.
            </li>
            <li>
              <code>.jex</code>: a Joplin export. Each note keeps its notebook, tags, dates and
              attachments; a notebook inside another is named for its whole path, as in
              Household / Receipts.
            </li>
            <li>
              <code>.pdf</code> or an image, any number of them: one note per file, named after
              it, with the file attached. The same as dropping files on the note list.
            </li>
          </ul>

          {/* Reading happens here in the browser, not on the server: a multi-GB file is
              minutes of local CPU with no server-side progress to fall back on. Saying so
              up front is what stops a slow import reading as a hung one. */}
          <p className="muted small">
            Large files are read on this machine, so a multi-gigabyte export can take
            several minutes and the tab needs to stay open. If it does get interrupted, start
            the same file again: nothing duplicates.
          </p>

          <EnexHelp />
          <NotionHelp />
          <JoplinHelp />

          {/* An import is nothing but writes, every one of which the server refuses
              while the plan has ended (MAK-108): the picker is faded with the reason
              rather than left to fail a note at a time. */}
          {planInactive && <p className="muted small">Importing needs an active plan. Everything already here still opens and exports.</p>}
          <input
            key={pickerKey}
            type="file"
            multiple
            accept=".enex,.jex,.zip,.md,.pdf,application/xml,text/xml,application/zip,text/markdown,application/pdf,image/*"
            disabled={planInactive}
            onChange={(e) => pick([...(e.target.files ?? [])])}
          />

          {batchProblem && <p className="import-file small bad">{batchProblem}</p>}

          {batch.length > 0 && (
            <div className="import-batch">
              <p className="import-file small">
                <span>{batch.length === 1 ? batch[0]!.name : `${count(batch.length, 'file')}`} · {formatBytes(batch.reduce((n, f) => n + f.size, 0))}</span>
                <span className="muted">
                  {batch.length === 1 ? 'One note, named after the file, with it attached.' : 'One note per file, named after it, with the file attached.'}
                </span>
              </p>
              {/* The one thing the drop decides from where it lands and the picker cannot:
                  where the notes go. The note's own picker, over the notebooks that exist,
                  rather than a name typed in: these notes are filed, not imported, and a
                  typo in a free field made a notebook. Inbox, the picker's first row, is
                  where a scan from the launch handler lands too. */}
              <label className="notion-pages-notebook small">
                <span className="muted">Notebook</span>
                <NotebookPicker className="search-field" notebook={batchNotebook} notebooks={notebooks.data?.notebooks} onChange={setBatchNotebook} />
              </label>
              <Button variant="primary" disabled={planInactive} tip={planInactive ? READ_ONLY_TIP : undefined} onClick={startBatch}>
                {batch.length === 1 ? 'Add note' : `Add ${batch.length} notes`}
              </Button>
            </div>
          )}

          {file && picked && (
            <p className="import-file small">
              <span>
                {file.name} · {formatBytes(file.size)}
              </span>
              {/* Says what the run will do with this file, or why it will not start. */}
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

          {/* The export's controls, not the batch's: files for notes are read for search
              the way a file dropped on a note is, with nothing to choose. */}
          {batch.length === 0 && (
            <>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={extractText}
                  onChange={(e) => setExtractText(e.target.checked)}
                />
                <span className="small">
                  Search inside PDFs: reads the text already embedded in scanned attachments,
                  by Evernote&apos;s OCR or a scanner&apos;s. Most scanned notes have no body
                  text, so without this they are only findable by title. Adds roughly a second
                  per PDF.
                </span>
              </label>

              <Button variant="primary" disabled={!canStart || planInactive} tip={planInactive ? READ_ONLY_TIP : undefined} onClick={start}>
                Start import
              </Button>
            </>
          )}

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
              field's name (see `ImportRun.problem`). */}
          <summary className="small">{failures.length} failed</summary>
          {/* The retry is free (importNote is idempotent per note), but nothing said so,
              so a run ending with failures looked like data lost rather than data to retry. */}
          <p className="small muted">
            Importing the same file again retries just these; everything that already landed
            is skipped.
          </p>
          <ul className="small">
            {failures.map((f, i) => (
              <li key={i}>
                <strong>{f.title}</strong>: {f.reason}
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
 * missing row would leave. Everything importable starts ticked (the common case is the
 * whole workspace), and All and None are one click each for the rest.
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
