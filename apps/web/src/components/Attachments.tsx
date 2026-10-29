import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import { removeAttachmentLinkChanges, rewriteText } from '../editor/links.js';
import type { AttachmentInfo } from '@unbent/shared';
import {
  attachmentFilenamesInMarkdown,
  formatAttachmentMarkdown,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { copyAttachmentToClipboard } from '../attachment-clipboard.js';
import { attachmentsQuery, keys } from '../queries.js';
import { formatBytes } from '../format-bytes.js';
import { useOutbox, useSyncStatus } from '../store/use-outbox.js';
import { deleteOrCancelAttachment } from '../store/actions.js';
import { Confirm } from './Confirm.js';
import { Button } from './Button';
import { Disclosure } from './Disclosure.js';
import { NotePicker, type PickedNote } from './NotePicker.js';
import { OverflowMenu } from './OverflowMenu.js';
import { READ_ONLY_TIP } from '../use-plan.js';

interface AttachmentsProps {
  noteId: string;
  /** Current draft body, used to mark files that are no longer linked. */
  body: string;
  /**
   * The editor's view as it is at the call, or null while none is mounted. A function
   * rather than the view, because a delete's round trip can outlive the view that was
   * mounted at the press (a rich/source switch rebuilds it), and a dispatch to a destroyed
   * view is taken silently and changes nothing.
   */
  editorViewNow: () => EditorView | null;
  /**
   * Called after a linked file is deleted so the editor can drop the markdown
   * destination and remount with the rewritten body.
   */
  onBodyRewrite: (nextBody: string) => void;
  /**
   * The note takes no changes right now: a save refused as stale and waiting on a choice,
   * or a tab that cannot queue writes while offline (`frozen` in `Workspace`). Every control
   * here that changes the note or its files is faded in place, as Auto-fill and ⋯ are, so
   * nothing moves when the connection drops; Copy and the download link still work.
   *
   * Insert link most of all: it dispatches into the editor directly, which CodeMirror's
   * read-only does not stop.
   */
  readOnly?: boolean;
  /**
   * The account's plan has ended (MAK-108): the server refuses every write but a delete.
   * Narrower than `readOnly`, which is for a note that cannot be reached at all. Here
   * the files still open, download and delete (that is what the banner promises) and
   * only what would write goes: copying or moving a file to another note, and inserting
   * a link, which edits the body.
   */
  lapsed?: boolean;
}

function fileUrl(noteId: string, filename: string): string {
  return `/api/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(filename)}?download=1`;
}

/**
 * Lists every file stored on the note, including ones whose markdown link was removed.
 *
 * Upload keeps the blob even when the link is cut: this panel is how you see and
 * permanently delete those leftovers. Unlinked files are called out in the summary so
 * an accidental sensitive upload is hard to miss.
 */
export function Attachments({
  noteId,
  body,
  editorViewNow,
  onBodyRewrite,
  readOnly = false,
  lapsed = false,
}: AttachmentsProps) {
  /** The writes a lapsed account cannot make, and why; `readOnly`'s word wins when both hold. */
  const noWrites = readOnly || lapsed;
  const noWritesTip = readOnly ? 'Not available offline' : lapsed ? READ_ONLY_TIP : undefined;
  const queryClient = useQueryClient();
  const { data: files = [], isLoading, error } = useQuery(attachmentsQuery(noteId));
  /*
     What became of files added here with no connection that did not simply upload: one
     the server refused, one it stored under another name. Said in this panel because it
     is where the file was listed while it waited, and it is the row vanishing from here
     that would otherwise be the only sign.
  */
  const outbox = useOutbox();
  const notices = useSyncStatus().uploadNotices.get(noteId) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Filename awaiting an explicit delete. */
  const [pending, setPending] = useState<string | null>(null);
  /**
   * The file whose Copy just succeeded, for the moment its label says so.
   *
   * A clipboard write has no visible result, so the button is the only place to say it
   * happened. The label reverts on its own rather than on the next click, because the
   * next click may be a paste in another note, which this panel never sees.
   */
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  /**
   * The file a note picker is open for, and whether it is going as a copy or a move.
   *
   * One at a time, like `pending`: two pickers open would be two questions with the same
   * answer box, and the row that opened the second has already lost the first.
   */
  const [sending, setSending] = useState<{ filename: string; mode: 'copy' | 'move' } | null>(
    null,
  );
  /** What the last copy-to or move-to did, with a link to where the file went. */
  const [sent, setSent] = useState<ReactNode>(null);

  // Deferred: the set is read from a parse of the whole body, which costs about a
  // millisecond and a half per kilobyte, and a keystroke is painted before it runs.
  // Fast typing coalesces into one parse of the latest draft; see `inlineLinks` in
  // `@unbent/shared`. What is drawn may therefore trail the draft by one parse, which
  // is why the actions below read the draft itself (`linkedNow`) and never this set: a
  // link pasted just before Delete was pressed would otherwise be left pointing at a
  // file that is gone.
  //
  // Deferred with the note it belongs to. On a switch the deferred value is still the
  // previous note's body for one render, against the new note's files, so every file
  // read as unlinked for that render and the panel latched open on every note with
  // files (the bug MAK-149 fixed, back again by another route). A deferred body from
  // another note is not used: the live one is parsed instead, once, on the switch.
  const draft = useMemo(() => ({ noteId, body }), [noteId, body]);
  const settled = useDeferredValue(draft);
  const settledBody = settled.noteId === noteId ? settled.body : body;
  const linked = useMemo(() => attachmentFilenamesInMarkdown(settledBody), [settledBody]);
  // Not a file still waiting to upload: the cleanup deletes on the server, which has no such file yet.
  const unlinked = files.filter((f) => !linked.has(f.filename) && !f.pending);
  const unlinkedCount = unlinked.length;
  const unlinkedBytes = unlinked.reduce((sum, f) => sum + f.size, 0);
  /**
   * Once a note has shown a file that is not linked, the panel stays open for the visit.
   *
   * Latched rather than derived, so deleting the last leftover does not collapse the
   * panel under the pointer that just clicked in it. The red count in the summary was
   * already the warning; this puts the files it counts on screen, since the point of the
   * warning is that they should be looked at.
   */
  const [hadUnlinked, setHadUnlinked] = useState(false);
  /** Whether the "delete all not linked" confirmation is showing. */
  const [cleaning, setCleaning] = useState(false);

  /*
     Workspace is reused across notes, and so is this panel. A delete or move's round trip
     outlives a switch the same way Auto-fill's does: `onBodyRewrite` writes the *current*
     draft, so finishing after the user has moved on would replace the incoming note's body
     with the previous one's. Drop the in-flight UI here so a Delete, Move, or "delete not
     linked" confirm started on the last note cannot sit on this one, especially when both
     happen to have a `scan.pdf`. The request itself is left to finish against the note it
     started on; wasting it is cheaper than landing the rewrite on the wrong one.
  */
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const bodyRef = useRef(body);
  bodyRef.current = body;
  /** What the draft links at this moment: one parse, at a press, never per keystroke. */
  const linkedNow = () => attachmentFilenamesInMarkdown(bodyRef.current);
  /**
   * Takes a deleted file's links out of the note, through the editor's own syntax tree
   * (`editor/links.ts`, the one place a body is rewritten): a change dispatched to the
   * open editor, or applied to the draft when no editor is mounted yet.
   */
  function dropLinks(filename: string) {
    const view = editorViewNow();
    if (view) {
      const changes = removeAttachmentLinkChanges(view.state, filename);
      if (changes.length > 0) view.dispatch({ changes });
      return;
    }
    onBodyRewrite(rewriteText(bodyRef.current, (state) => removeAttachmentLinkChanges(state, filename)));
  }
  useEffect(() => {
    setPending(null);
    setSending(null);
    setCleaning(false);
    setSent(null);
    setDeleteError(null);
    setCopied(null);
    setBusy(null);
    setHadUnlinked(false);
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
  }, [noteId]);
  useEffect(() => {
    if (unlinkedCount > 0) setHadUnlinked(true);
  }, [unlinkedCount, noteId]);
  // A question left open when the note locks would go on offering what it can no longer
  // do. A lapse closes only the copy and move; a delete stays askable.
  useEffect(() => {
    if (!readOnly && !lapsed) return;
    if (readOnly) {
      setPending(null);
      setCleaning(false);
    }
    setSending(null);
  }, [readOnly, lapsed]);

  function insertLink(file: AttachmentInfo) {
    if (noWrites) return;
    const markdown = formatAttachmentMarkdown(file.filename, `files/${file.filename}`, {
      image: file.contentType.startsWith('image/'),
    });

    const view = editorViewNow();
    if (view) {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
      });
      view.focus();
      return;
    }

    // Editor not mounted yet: append rather than drop the action.
    const next = body.trimEnd() === '' ? markdown : `${body.trimEnd()}\n\n${markdown}`;
    onBodyRewrite(next);
  }

  /**
   * Puts a link to the file on the clipboard, and the picture too, for an image.
   *
   * This is how a file gets to another note: paste the link there and the editor copies
   * the file across (see editor/clipboard.ts). A PDF cannot be put on a clipboard by a
   * web page at all, so a link is the one form that works for every file, and it is the
   * faster one besides.
   */
  async function copy(file: AttachmentInfo) {
    setDeleteError(null);
    try {
      await copyAttachmentToClipboard(noteId, file, { origin: window.location.origin });
      setCopied(file.filename);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1500);
    } catch (err) {
      setDeleteError(`Couldn’t copy. ${(err as Error).message}`);
    }
  }

  /**
   * Sends a file to another note, as a copy or a move.
   *
   * Both start with the same server-side copy, linked into the destination's body since
   * no editor is open there to do it. A move then deletes the file here (the same
   * delete the row's Delete button does, link removal included) rather than asking the
   * server to move it: the server's own move declines to take a file this body still
   * links, which is right for a paste after a cut but not for an explicit "move this".
   * Copy first, then delete, so a failure between the two leaves the file in both notes
   * rather than in neither.
   */
  async function sendTo(file: AttachmentInfo, target: PickedNote, mode: 'copy' | 'move') {
    const startedFor = noteId;
    const stillLinked = linkedNow().has(file.filename);
    setBusy(file.filename);
    setDeleteError(null);
    setSent(null);
    try {
      await api.copyAttachments(target.id, {
        from: startedFor,
        filenames: [file.filename],
        link: true,
      });
      void queryClient.invalidateQueries({ queryKey: keys.attachments(target.id) });
      void queryClient.invalidateQueries({ queryKey: keys.note(target.id) });
      if (mode === 'move') {
        await api.deleteAttachment(startedFor, file.filename);
        if (stillLinked && noteIdRef.current === startedFor) {
          dropLinks(file.filename);
        }
        await queryClient.invalidateQueries({ queryKey: keys.attachments(startedFor) });
      }
      // The list rows show what each note holds.
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      if (noteIdRef.current !== startedFor) return;
      setSending(null);
      setSent(
        <>
          {mode === 'move' ? 'Moved' : 'Copied'} “{file.filename}” to{' '}
          <Link to="/notes/$noteId" params={{ noteId: target.id }} search={(p) => p} className="link">
            {target.title || 'Untitled'}
          </Link>
          .
        </>,
      );
    } catch (err) {
      if (noteIdRef.current === startedFor) setDeleteError((err as Error).message);
    } finally {
      if (noteIdRef.current === startedFor) setBusy(null);
    }
  }

  /**
   * Every file the note no longer links, gone in one confirmation.
   *
   * What a cut, an abandoned paste, or a note converted by an assistant leaves behind,
   * which used to be one confirmation per file. Sequential, and stopping at the first
   * failure with the error shown: the list refetches either way, so what remains is
   * what is still stored.
   */
  async function removeUnlinked() {
    const startedFor = noteId;
    const now = linkedNow();
    const toDelete = files.filter((f) => !now.has(f.filename) && !f.pending);
    setCleaning(false);
    setBusy('*');
    setDeleteError(null);
    try {
      for (const file of toDelete) await api.deleteAttachment(startedFor, file.filename);
    } catch (err) {
      if (noteIdRef.current === startedFor) setDeleteError((err as Error).message);
    } finally {
      await queryClient.invalidateQueries({ queryKey: keys.attachments(startedFor) });
      if (noteIdRef.current === startedFor) setBusy(null);
    }
  }

  async function remove(filename: string) {
    const startedFor = noteId;
    const stillLinked = linkedNow().has(filename);
    setPending(null);
    setBusy(filename);
    setDeleteError(null);
    try {
      // A file still waiting to upload is taken back on this device; anything else is the
      // server's to delete.
      await deleteOrCancelAttachment(startedFor, filename);
      // Not while the plan has ended: the editor takes no edits and the autosave is off,
      // so a rewrite would show the link gone until the note was reopened and then bring
      // it back, pointing at nothing. The link stays, and the confirm said it would.
      if (stillLinked && !lapsed && noteIdRef.current === startedFor) {
        dropLinks(filename);
      }
      await queryClient.invalidateQueries({ queryKey: keys.attachments(startedFor) });
    } catch (err) {
      if (noteIdRef.current === startedFor) setDeleteError((err as Error).message);
    } finally {
      if (noteIdRef.current === startedFor) setBusy(null);
    }
  }

  if (isLoading) return null;
  if (error) {
    return (
      <p className="bad small attachments-error">
        Couldn’t load attachments. {(error as Error).message}
      </p>
    );
  }
  const said = notices.length > 0 && (
    <div className="attachments-notices" role="status">
      {notices.map((n) => (
        <p key={n.id} className="bad small">
          {n.filename !== undefined && <>“{n.filename}”: </>}
          {n.message}
        </p>
      ))}
      <Button variant="quiet" size="small" onClick={() => outbox?.dismissUploadNotices(noteId)}>
        Dismiss
      </Button>
    </div>
  );
  if (files.length === 0) return said || null;

  return (
    /* Closed at every width, unlike the filing row above it: this list is as long as the
       note has files, and every row of it carries a delete. */
    <Disclosure
      className="attachments"
      defaultOpen={hadUnlinked ? 'always' : 'never'}
      summary={
        <>
          Attachments ({files.length})
          {unlinkedCount > 0 && (
            <span className="attachments-warn">
              {' '}
              · {unlinkedCount} not linked in note
            </span>
          )}
        </>
      }
    >
      {unlinkedCount > 1 && (
        <div className="attachments-cleanup">
          <span className="muted small">
            {unlinkedCount} files not linked in the note, {formatBytes(unlinkedBytes)}.
          </span>
          <Button
            variant="quiet"
            tone="danger"
            size="small"
            disabled={busy !== null || readOnly}
            tip={readOnly ? 'Not available offline' : undefined}
            onClick={() => {
              setPending(null);
              setSending(null);
              setCleaning(true);
            }}
          >
            {busy === '*' ? 'Deleting…' : `Delete ${unlinkedCount} not linked`}
          </Button>
          {cleaning && (
            <Confirm
              label="Confirm delete not linked files"
              question={<>Permanently delete the {unlinkedCount} files not linked in this note?</>}
              detail={`${formatBytes(unlinkedBytes)} in total. This cannot be undone.`}
              busy={busy === '*'}
              onCancel={() => setCleaning(false)}
              actions={[
                {
                  label: `Delete ${unlinkedCount} files`,
                  busyLabel: 'Deleting…',
                  tone: 'danger',
                  onConfirm: () => void removeUnlinked(),
                },
              ]}
            />
          )}
        </div>
      )}

      <ul className="attachments-list">
        {files.map((file) => {
          const isLinked = linked.has(file.filename);
          /*
             Added here and not uploaded yet. The row is real (the file draws in the note
             from this device's copy), but the server has no file to copy or move, so what
             would ask it to waits with the upload. Insert link still works: it only
             writes into the note. And so does Delete, which for this file is taking it
             back: the wrong photo attached with no connection should not have to upload
             before it can be removed (review of #236).
          */
          const waiting = file.pending === true;
          const held = waiting ? 'Waiting to upload' : undefined;
          return (
            <li
              key={file.filename}
              className={isLinked ? 'attachments-row' : 'attachments-row unlinked'}
            >
              <div className="attachments-info">
                {waiting ? (
                  // Not a link while it waits: a download is a page load, which only the
                  // server answers (`shelved` in sw/routes.ts), and it has no such file yet.
                  <span className="attachments-name">{file.filename}</span>
                ) : (
                  <a
                    className="attachments-name link"
                    href={fileUrl(noteId, file.filename)}
                    download={file.filename}
                    title={`Download ${file.filename}`}
                  >
                    {file.filename}
                  </a>
                )}
                <span className="attachments-meta small">
                  <span className="muted">{formatBytes(file.size)}</span>
                  {waiting && <span className="attachments-status waiting">Waiting to upload</span>}
                  {!isLinked && <span className="attachments-status">Not linked</span>}
                </span>
              </div>
              <div className="attachments-actions">
                <Button
                  variant="quiet"
                  size="small"
                  disabled={busy !== null || waiting}
                  tip={held ?? 'Copy a link to paste into another note'}
                  onClick={() => void copy(file)}
                >
                  {copied === file.filename ? 'Copied' : 'Copy'}
                </Button>
                {/*
                    Copy-to and move-to behind a ⋯ rather than beside Copy and Delete: on a
                    phone the row is 320px wide, and four labelled buttons on every file
                    would leave the filename nothing. These are the two that need a second
                    step anyway (a note to pick), so a menu costs them no extra tap.
                */}
                <OverflowMenu
                  label={`More actions for ${file.filename}`}
                  className="attachments-more"
                  disabled={noWrites || waiting}
                  tip={held ?? noWritesTip}
                  items={[
                    {
                      label: 'Copy to note…',
                      onSelect: () => {
                        setPending(null);
                        setSending({ filename: file.filename, mode: 'copy' });
                      },
                    },
                    {
                      label: 'Move to note…',
                      onSelect: () => {
                        setPending(null);
                        setSending({ filename: file.filename, mode: 'move' });
                      },
                    },
                  ]}
                />
                {!isLinked && (
                  <Button
                    variant="quiet"
                    size="small"
                    disabled={busy !== null || noWrites}
                    tip={noWritesTip}
                    onClick={() => insertLink(file)}
                  >
                    Insert link
                  </Button>
                )}
                <Button
                  variant="quiet"
                  tone="danger"
                  size="small"
                  disabled={busy !== null || readOnly}
                  tip={readOnly ? 'Not available offline' : undefined}
                  onClick={() => {
                    setSending(null);
                    setPending(file.filename);
                  }}
                >
                  {busy === file.filename ? 'Deleting…' : 'Delete'}
                </Button>
              </div>

              {sending?.filename === file.filename && (
                <NotePicker
                  label={sending.mode === 'move' ? 'Move to note' : 'Copy to note'}
                  excludeId={noteId}
                  busy={busy === file.filename}
                  onCancel={() => setSending(null)}
                  onPick={(target) => void sendTo(file, target, sending.mode)}
                />
              )}

              {pending === file.filename && (
                <Confirm
                  label="Confirm delete attachment"
                  question={waiting ? <>Remove “{file.filename}” before it uploads?</> : <>Permanently delete “{file.filename}”?</>}
                  detail={
                    waiting
                      ? `It has not uploaded, so this device holds the only copy.${isLinked ? ' Its link in this note will be removed too.' : ''}`
                      : isLinked
                        ? lapsed
                          ? 'It is still linked in this note; the link stays until the plan is active again. This cannot be undone.'
                          : 'It is still linked in this note; the link will be removed too.'
                        : 'This cannot be undone.'
                  }
                  busy={busy === file.filename}
                  onCancel={() => setPending(null)}
                  actions={[
                    {
                      label: waiting ? 'Remove file' : 'Delete file',
                      busyLabel: waiting ? 'Removing…' : 'Deleting…',
                      tone: 'danger',
                      onConfirm: () => void remove(file.filename),
                    },
                  ]}
                />
              )}
            </li>
          );
        })}
      </ul>

      {said}
      {sent && <p className="muted small attachments-sent">{sent}</p>}
      {deleteError && <p className="bad small">{deleteError}</p>}
    </Disclosure>
  );
}
