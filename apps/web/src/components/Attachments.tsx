import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import type { AttachmentInfo } from '@unbent/shared';
import {
  attachmentFilenamesInMarkdown,
  formatAttachmentMarkdown,
  removeAttachmentLinks,
} from '@unbent/shared';
import * as api from '../notes-api.js';
import { attachmentsQuery, keys } from '../queries.js';

interface AttachmentsProps {
  noteId: string;
  /** Current draft body — used to mark files that are no longer linked. */
  body: string;
  /** Live editor view; used to insert a link at the cursor. */
  editorView: EditorView | null;
  /**
   * Called after a linked file is deleted so the editor can drop the markdown
   * destination and remount with the rewritten body.
   */
  onBodyRewrite: (nextBody: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fileUrl(noteId: string, filename: string): string {
  return `/api/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(filename)}?download=1`;
}

/**
 * Lists every file stored on the note, including ones whose markdown link was removed.
 *
 * Upload keeps the blob even when the link is cut — this panel is how you see and
 * permanently delete those leftovers. Unlinked files are called out in the summary so
 * an accidental sensitive upload is hard to miss.
 */
export function Attachments({
  noteId,
  body,
  editorView,
  onBodyRewrite,
}: AttachmentsProps) {
  const queryClient = useQueryClient();
  const { data: files = [], isLoading, error } = useQuery(attachmentsQuery(noteId));
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const linked = useMemo(() => attachmentFilenamesInMarkdown(body), [body]);
  const unlinkedCount = files.filter((f) => !linked.has(f.filename)).length;

  function insertLink(file: AttachmentInfo) {
    const markdown = formatAttachmentMarkdown(file.filename, `files/${file.filename}`, {
      image: file.contentType.startsWith('image/'),
    });

    if (editorView) {
      const { from, to } = editorView.state.selection.main;
      editorView.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
      });
      editorView.focus();
      return;
    }

    // Editor not mounted yet — append rather than drop the action.
    const next = body.trimEnd() === '' ? markdown : `${body.trimEnd()}\n\n${markdown}`;
    onBodyRewrite(next);
  }

  async function remove(filename: string) {
    const stillLinked = linked.has(filename);
    const message = stillLinked
      ? `Permanently delete “${filename}”? It is still linked in the note — the link will be removed too.`
      : `Permanently delete “${filename}”? This cannot be undone.`;
    if (!confirm(message)) return;

    setBusy(filename);
    setDeleteError(null);
    try {
      await api.deleteAttachment(noteId, filename);
      if (stillLinked) {
        onBodyRewrite(removeAttachmentLinks(body, filename));
      }
      await queryClient.invalidateQueries({ queryKey: keys.attachments(noteId) });
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setBusy(null);
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
  if (files.length === 0) return null;

  return (
    <details className="attachments">
      <summary>
        Attachments ({files.length})
        {unlinkedCount > 0 && (
          <span className="attachments-warn">
            {' '}
            · {unlinkedCount} not linked in note
          </span>
        )}
      </summary>

      <ul className="attachments-list">
        {files.map((file) => {
          const isLinked = linked.has(file.filename);
          return (
            <li
              key={file.filename}
              className={isLinked ? 'attachments-row' : 'attachments-row unlinked'}
            >
              <div className="attachments-info">
                <a
                  className="attachments-name link"
                  href={fileUrl(noteId, file.filename)}
                  download={file.filename}
                  title={`Download ${file.filename}`}
                >
                  {file.filename}
                </a>
                <span className="attachments-meta small">
                  <span className="muted">{formatBytes(file.size)}</span>
                  {!isLinked && <span className="attachments-status">Not linked</span>}
                </span>
              </div>
              <div className="attachments-actions">
                {!isLinked && (
                  <button
                    type="button"
                    className="link"
                    disabled={busy !== null}
                    onClick={() => insertLink(file)}
                  >
                    Insert link
                  </button>
                )}
                <button
                  type="button"
                  className="link danger"
                  disabled={busy !== null}
                  onClick={() => void remove(file.filename)}
                >
                  {busy === file.filename ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {deleteError && <p className="bad small">{deleteError}</p>}
    </details>
  );
}
