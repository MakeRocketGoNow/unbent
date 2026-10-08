import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button, type ButtonTone, type ButtonVariant } from './Button';

export interface ConfirmAction {
  label: string;
  /** Shown in place of `label` while the action runs; falls back to `label`. */
  busyLabel?: string;
  /**
   * `primary` is the reassuring outcome, `danger` the destructive one. A confirm may have
   * a danger action and no primary (delete every note), a primary that *is* the
   * destruction (empty the trash), or one of each — the notebook case: keep the notes, or
   * don't.
   *
   * `neutral` is a reassuring outcome like `primary`, but filled in the page's ink rather
   * than the brand green — for the keep-vs-clear pair, where a green fill beside the red
   * danger button reads as two colours fighting. It weighs exactly as `primary` does; only
   * its hue differs.
   */
  tone: 'primary' | 'neutral' | 'danger';
  onConfirm: () => void | Promise<void>;
}

export interface ConfirmProps {
  /** Accessible name for the region, e.g. "Confirm delete notebook". */
  label: string;
  /** The question, asked in full. */
  question: ReactNode;
  /** What happens and what survives. Rendered small and muted. */
  detail?: ReactNode;
  /** The choices, in reading order. See `actionWeight` for how order sets weight. */
  actions: ConfirmAction[];
  /**
   * When set, every action stays disabled until the user types this string exactly.
   * Reserved for operations with no undo whose button is itself the irreversible step —
   * today "delete every note in this account", and an operator deleting someone's account.
   */
  requireTyped?: string;
  busy?: boolean;
  onCancel: () => void;
  /**
   * Put focus on Cancel when the confirm mounts. For a confirm that appears away from
   * what was pressed — the sign-out question, after the account menu has closed and
   * focus has gone back to the page — so keyboard and screen-reader users reach it, on
   * the safe choice. A confirm that opens in place of the control that was pressed
   * leaves focus where it is.
   */
  focusCancel?: boolean;
}

/**
 * Weight by position: the first action is the one being offered, and a destructive action
 * that comes *after* a safe one demotes itself — a quieter outlined button, dropped to its
 * own line below the one it must not be mistaken for.
 *
 * This is the rule that keeps someone from trashing 47 notes by muscle memory, so it lives
 * in code rather than in each caller's class names — a caller passing the two notebook
 * outcomes in the right order gets the right emphasis without having to know about it.
 *
 * Returns `Button` props rather than a class string, plus `ownLine` so the render can wrap
 * the demoted action without spelling the demotion rule out twice. The demoted action has
 * been three shapes: a `class="link"` with no hit area (a control that still destroys 47
 * notes, drawn as text), then a full-width `quiet` bar on its own line — which read as odd,
 * and on hover lit up the entire row rather than a button (MAK-88). It is now an ordinary
 * outlined `danger` button: bordered, the same height as the primary beside it, sized to its
 * own label, and still on its own line so it stays a deliberate reach.
 */
function actionWeight(
  action: ConfirmAction,
  index: number,
): { variant: ButtonVariant; tone: ButtonTone; ownLine: boolean } {
  if (action.tone === 'primary') return { variant: 'primary', tone: 'default', ownLine: false };
  // Filled like a primary, but in the page's ink — the affirmative that shares a row with
  // a danger button without the two fills clashing. Weighs the same, so it never demotes.
  if (action.tone === 'neutral') return { variant: 'primary', tone: 'neutral', ownLine: false };
  if (index > 0) {
    return { variant: 'secondary', tone: 'danger', ownLine: true };
  }
  return { variant: 'primary', tone: 'danger', ownLine: false };
}

/**
 * The border takes the tone of the action being offered — the first one — so a box never
 * wears a colour its own button contradicts.
 *
 * It used to be red for every question, including "keep this notebook on the device?",
 * which put a warning colour around a safe green action: a red box with a green button in
 * it, and the owner's verdict that it read as Christmas. Deriving it here rather than
 * taking a prop is the point — a caller cannot get it wrong. Only the first action counts:
 * a demoted danger after a safe first choice is the quiet option, not what the box is about.
 */
function borderTone(actions: ConfirmAction[]): 'danger' | 'primary' | 'neutral' {
  const first = actions[0]?.tone;
  return first === 'danger' || first === 'primary' ? first : 'neutral';
}

/**
 * Inline confirmation for an action that cannot be undone.
 *
 * A region rather than a dialog, and deliberately so: every confirmation in this app is
 * about something specific on screen — a named notebook and its note count, a trash with a
 * number in it — and a modal covers the very thing being decided about, forcing its
 * details into the prompt text. Staying inline also means no focus trap, no scroll lock and
 * no portal, none of which exist anywhere else here.
 *
 * Replaces `confirm()`, which was modal in exactly the way that made it worth removing.
 */
export function Confirm({
  label,
  question,
  detail,
  actions,
  requireTyped,
  busy = false,
  onCancel,
  focusCancel = false,
}: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // The one real cost of staying inline: a confirm rendered below the fold reads as a dead
  // click. A dialog gets this free by covering the viewport; here it is two lines. Guarded
  // because jsdom has no scrollIntoView, and scrolling is not worth failing a render over.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const locked = requireTyped !== undefined && typed !== requireTyped;

  return (
    <div
      ref={ref}
      className={`confirm confirm-${borderTone(actions)}`}
      role="group"
      aria-label={label}
      // Focusable so Escape lands here rather than on whatever was clicked to open it.
      // Escape cancelling is what confirm() did, and what a dialog would do.
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <p>{question}</p>
      {detail && <p className="small muted">{detail}</p>}

      {requireTyped !== undefined && (
        <input
          className="search-field confirm-token"
          value={typed}
          placeholder={requireTyped}
          disabled={busy}
          autoFocus
          aria-label={`Type ${requireTyped} to confirm`}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}

      <div className="confirm-actions">
        {actions.map((action, i) => {
          const { ownLine, ...weight } = actionWeight(action, i);
          const button = (
            <Button
              key={action.label}
              {...weight}
              disabled={busy || locked}
              onClick={() => void action.onConfirm()}
            >
              {busy ? (action.busyLabel ?? action.label) : action.label}
            </Button>
          );
          // The demoted destructive option keeps its own line: the wrapper spans the row so
          // the button drops below the safe choice, while the button itself stays its own
          // width — its border and hover fill stop at the label, not the panel edge.
          return ownLine ? (
            <div key={action.label} className="confirm-action-own-line">
              {button}
            </div>
          ) : (
            button
          );
        })}
        <Button variant="secondary" disabled={busy} autoFocus={focusCancel} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
