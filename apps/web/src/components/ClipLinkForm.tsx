import { useEffect, useId, useRef, useState } from 'react';
import type { Note } from '@unbent/shared';
import * as actions from '../store/actions.js';
import { ApiError, errorText } from '../notes-api.js';
import { isFreeNotesFull, showFreeNotesFull } from '../free-notes.js';
import { Button } from './Button';

interface ClipLinkFormProps {
  /** Where the note goes: the list's own filing, as New files a note (`NotesLayout`'s `filing`). */
  filing: { tags: string[]; notebook: string | null };
  /** Faded with the reason while the server is out of reach: the server does the fetching. */
  offline: boolean;
  /**
   * Without the Cancel button: the phone's row, where the head draws the back arrow that
   * closes the form, as it does for the search (see `NoteListHead`'s `clipping`).
   */
  compact?: boolean;
  /** The note is made and in the local copy; the caller opens it. */
  onClipped: (note: Note) => void;
  onCancel: () => void;
}

/**
 * What a web address pasted into the field may lack: a scheme. Someone copying from a
 * browser's address bar gets one; someone typing `example.com/article` does not, and
 * "That isn't a web address" for a thing that plainly is would be the form being pedantic.
 * `https` because nearly every site has it and the server follows a redirect to `http`
 * if one is needed, where the other way round would be refused by most sites.
 */
export function asPageUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The line under the field: the route's own sentence, as `errorText` reads it, except
 * for a file where a page was expected. That sentence is written for the `clip_web_page`
 * tool as much as for a person (it names `add_attachment`, which means nothing here), so
 * the form says that one case in its own words; every other answer the route gives (a
 * site that refused, an address it will not fetch, a page too large) is already a
 * sentence for a person.
 */
export function whatWentWrong(err: unknown): string {
  if (err instanceof ApiError && err.code === 'NOT_A_PAGE') {
    return "That's a file, not a web page. Attach it to a note instead.";
  }
  return errorText(err);
}

/**
 * The inline form a link is clipped from: one field, Clip, and Cancel.
 *
 * Inline, in the row the search field has, rather than a dialog: the address is one
 * line, and the list the note will appear in is the thing a dialog would cover. Enter
 * clips and Escape leaves, as the view name field does; the buttons are the same two for
 * a pointer and a thumb. What went wrong is a line under the field, not a snackbar: the
 * server's answer is about this address (a PDF rather than a page, a site that refused,
 * an address it will not fetch), and the field is where the eye is, with the address
 * still in it to fix or copy.
 *
 * A request made now, never queued (`actions.clipLink`): the server fetches the page, so
 * with no connection the button fades with the reason rather than taking the address
 * into the outbox for later, which would clip whatever the page says by then.
 */
export function ClipLinkForm({ filing, offline, compact = false, onClipped, onCancel }: ClipLinkFormProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // Focus on arrival: the field is the whole point of opening the form.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function commit() {
    if (busy || offline) return;
    const url = asPageUrl(value);
    if (!url) {
      setError(value.trim() === '' ? 'Paste the address of a web page.' : "That isn't a web address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const note = await actions.clipLink({ url, tags: filing.tags, notebook: filing.notebook });
      onClipped(note);
    } catch (err) {
      // The free plan full is an answer, not a fault, and its notice says it (as New's
      // does); the form closes, since there is nothing to fix in the field.
      if (isFreeNotesFull(err)) {
        showFreeNotesFull();
        onCancel();
        return;
      }
      setError(whatWentWrong(err));
      setBusy(false);
      // Back to the field, once it is enabled again: a disabled input does not take focus.
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  const clipTip = offline ? 'Clipping needs a connection' : undefined;

  return (
    <div className="clip-link">
      <div className="clip-link-row">
        <input
          ref={ref}
          className="search-field clip-link-field"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder="Paste a link to clip"
          aria-label="Link to clip"
          aria-invalid={error !== null || undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <Button
          variant="secondary"
          size="small"
          className="clip-link-action"
          disabled={busy || offline}
          tip={clipTip}
          aria-busy={busy || undefined}
          onClick={() => void commit()}
        >
          {busy ? 'Clipping…' : 'Clip'}
        </Button>
        {!compact && (
          <Button variant="quiet" size="small" className="clip-link-action" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <p id={errorId} className="bad small clip-link-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
