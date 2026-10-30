import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { Note } from '@unbent/shared';
import * as actions from '../store/actions.js';
import { ApiError, errorText } from '../notes-api.js';
import { isFreeNotesFull, showFreeNotesFull } from '../free-notes.js';
import { Button } from './Button';

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
  // A colon then a port is not a scheme, though `example.com:8080` parses as one.
  const withScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(trimmed) ? trimmed : `https://${trimmed}`;
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

const NEEDS_CONNECTION = 'Clipping needs a connection.';

/** Why the controls that would close the form are faded while it clips. */
export const CLIP_RUNNING_TIP = 'Clipping this link';

interface ClipLinkOptions {
  /** Where the note goes: the list's own filing, as New files a note (`NotesLayout`'s `filing`). */
  filing: { tags: string[]; notebook: string | null };
  /** Faded with the reason while the server is out of reach: the server does the fetching. */
  offline: boolean;
  /** The press has gone to the server: what the caller wants to remember about that moment. */
  onStart?: () => void;
  /** The library holds the note; the caller opens it. Not called once the caller has gone. */
  onClipped: (note: Note) => void;
  /** The form has nothing more to say: the free plan's notice has taken over. */
  onCancel: () => void;
}

export interface ClipLinkState {
  value: string;
  busy: boolean;
  error: string | null;
  /** Whether the field takes focus the next time it can: on opening, and after a failure. */
  focusNext: RefObject<boolean>;
  change: (value: string) => void;
  commit: () => Promise<void>;
  /** Back to an empty form, for the next time it opens. */
  reset: () => void;
}

/**
 * What the form holds, kept by the caller rather than the form because the form moves.
 * `NoteListHead` draws it in a different place for a toolbar, a stacked head and a phone,
 * and a table row opening beside it is enough to change which, so a form that held its own
 * state came back empty and enabled while its clip was still running, one press from a
 * second note. Held here the address, the wait and the error survive that.
 */
export function useClipLink({ filing, offline, onStart, onClipped, onCancel }: ClipLinkOptions): ClipLinkState {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusNext = useRef(true);
  // One id for one address, kept across presses: an answer lost on the way back leaves the
  // address in the field and invites another press, and a server that already made the
  // note answers that id with it rather than fetching the page and its pictures again.
  const attempt = useRef<string | null>(null);

  // A clip outlives the notes layout if someone goes to Settings while it runs. The note
  // still lands, and shows up in the list; it does not pull them back to open it.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Said to a press made offline, and untrue once the connection is back.
  useEffect(() => {
    if (!offline) setError((shown) => (shown === NEEDS_CONNECTION ? null : shown));
  }, [offline]);

  function reset() {
    setValue('');
    setBusy(false);
    setError(null);
    attempt.current = null;
    focusNext.current = true;
  }

  async function commit() {
    if (busy) return;
    // Enter reaches here with the button faded, and a phone never draws that button's tip.
    if (offline) {
      setError(NEEDS_CONNECTION);
      return;
    }
    const url = asPageUrl(value);
    if (!url) {
      setError(value.trim() === '' ? 'Paste the address of a web page.' : "That isn't a web address.");
      return;
    }
    setBusy(true);
    setError(null);
    onStart?.();
    try {
      attempt.current ??= crypto.randomUUID();
      const note = await actions.clipLink({ id: attempt.current, url, tags: filing.tags, notebook: filing.notebook });
      if (!live.current) return;
      reset();
      onClipped(note);
    } catch (err) {
      // The free plan full is an answer, not a fault, and its notice says it (as New's
      // does); the form closes, since there is nothing to fix in the field.
      if (isFreeNotesFull(err)) {
        showFreeNotesFull();
        if (live.current) onCancel();
        return;
      }
      if (!live.current) return;
      setError(whatWentWrong(err));
      setBusy(false);
      focusNext.current = true;
    }
  }

  function change(next: string) {
    setValue(next);
    attempt.current = null;
    if (error) setError(null);
  }

  return { value, busy, error, focusNext, change, commit, reset };
}

interface ClipLinkFormProps {
  clip: ClipLinkState;
  offline: boolean;
  /**
   * Without the Cancel button: the phone's row, where the head draws the back arrow that
   * closes the form, as it does for the search (see `NoteListHead`'s `clipping`).
   */
  compact?: boolean;
  onCancel: () => void;
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
export function ClipLinkForm({ clip, offline, compact = false, onCancel }: ClipLinkFormProps) {
  const { value, busy, error } = clip;
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // On arrival, and back to the field after a failure, once it is enabled again: a disabled
  // input does not take focus. Not on every arrival: when the head's layout changes under
  // an open form this is a new element, and the note just opened beside it keeps the focus.
  useEffect(() => {
    if (busy || !clip.focusNext.current) return;
    clip.focusNext.current = false;
    ref.current?.focus();
  }, [busy, clip.focusNext]);

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
          onChange={(e) => clip.change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void clip.commit();
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
          onClick={() => void clip.commit()}
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
