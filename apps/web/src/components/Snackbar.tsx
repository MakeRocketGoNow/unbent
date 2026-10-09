import { useEffect, useRef } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';

import { Button } from './Button';

export interface SnackbarAction {
  label: string;
  onClick: () => void;
}

/** A place to go about the result, e.g. the page a background run reports on. */
export interface SnackbarLink {
  label: string;
  to: LinkProps['to'];
}

export interface SnackbarProps {
  /** The line shown. Kept short — a snackbar is glanced at, not read. */
  message: string;
  /**
   * `info` is a result to acknowledge (green tint); `error` is a failure to notice (red
   * tint). An error stays until dismissed — see `Workspace`, which passes no duration
   * for one — and so does the outcome of a run too long to watch (`ExportSnackbar`).
   */
  tone: 'info' | 'error';
  /** One optional action, e.g. Undo. Its click dismisses the snackbar too. */
  action?: SnackbarAction;
  /**
   * Or a link, when what there is to do about it is go and look. A link and not an
   * action, because it navigates: it can be opened in a new tab and should be. It does
   * not dismiss — a snackbar that is about a page hides itself on that page.
   */
  link?: SnackbarLink;
  /**
   * Milliseconds until it clears itself. Omit and it stays until the close button: for a
   * failure, so it is never lost to a timer before it is read, and for the end of a long
   * run, whose result lands after the person has looked away.
   */
  duration?: number;
  onDismiss: () => void;
}

/**
 * A result that speaks for a moment and leaves — the Android snackbar, for the one-shot
 * outcome of a press (today, Auto-fill's).
 *
 * Fixed to the bottom of the screen rather than beside the title, because the header is
 * for what the note *is* — its name, the way back — not for what just happened to it; a
 * status that lands and fades there competes with the autosave state for one small slot
 * and, on a phone, for the room the title needs. The bottom is where a phone user's
 * attention already rests and where this platform puts transient results.
 *
 * It carries an action, because a result worth showing is often one worth undoing, and a
 * toast that only tells is a toast you cannot act on. An error keeps its close button and
 * no timer: a failure the user must read is the one thing that must not vanish on its own.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader hears the outcome without
 * being yanked from what it was on — the same register the reader gets the "Saved" in.
 */
export function Snackbar({ message, tone, action, link, duration, onDismiss }: SnackbarProps) {
  // The latest onDismiss without resetting the timer when the parent re-renders: the timer
  // is tied to this message's life, not to each render of it.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (duration === undefined) return;
    const id = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(id);
  }, [duration]);

  return (
    <div className={`snackbar ${tone}`} role="status" aria-live="polite">
      <span className="snackbar-message">{message}</span>
      {action && (
        <Button
          variant="quiet"
          size="small"
          className="snackbar-action"
          onClick={() => {
            action.onClick();
            onDismiss();
          }}
        >
          {action.label}
        </Button>
      )}
      {link && (
        <Link to={link.to} className="snackbar-action snackbar-link">
          {link.label}
        </Link>
      )}
      <Button
        variant="quiet"
        size="small"
        className="snackbar-close"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        ✕
      </Button>
    </div>
  );
}
