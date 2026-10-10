import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * How much weight the control carries, not what it does to your data.
 *
 * `primary` fills: the one thing this view is for, at most once per view.
 * `secondary` outlines: a real action that is not the main one — the common case, and the
 * variant to reach for when unsure.
 * `quiet` drops the border: an action in a dense row (a note in a list, a toolbar) where
 * a grid of outlines would read as noisier than the content it sits beside. It is still a
 * button — padding, hover fill and a hit area — not text pretending to be one.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

/**
 * What the action does, orthogonal to `variant`.
 *
 * Kept separate because "destructive" and "prominent" are different questions: Delete
 * forever is destructive and quiet, Empty trash is destructive and primary. The same
 * vocabulary `Confirm` uses for its actions.
 *
 * `neutral` is the affirmative that must not read as the brand's green — the reassuring
 * choice standing next to a `danger` one, where a filled accent and a filled red clash as
 * two saturated colours competing. Filled in the page's own ink instead (dark on light,
 * light on dark), it carries a primary's weight without the hue. Only meaningful on
 * `primary`; on an outlined or quiet button it has nothing to fill and falls back to plain.
 */
export type ButtonTone = 'default' | 'danger' | 'neutral';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  children: ReactNode;
  /** Defaults to `secondary` — the safe choice for an action that is not the view's point. */
  variant?: ButtonVariant;
  tone?: ButtonTone;
  /**
   * `small`: denser padding and smaller text, for rows and toolbars.
   * `large`: 44px tall, for the few actions of a state that stands on its own — the
   * empty state's import, New note and its quiet sample note — where the controls are
   * most of what is on screen and a toolbar's height would make them look an
   * afterthought. The class is `btn-large`, which a `Link` wearing button classes can
   * share the way it shares `btn-primary`.
   */
  size?: 'default' | 'small' | 'large';
  /**
   * The tooltip (`tooltips.ts`), and the control's accessible description: what the
   * button's name does not say — why it is faded, or what it will do beyond its word.
   * One prop for both because the bubble is only drawn, and a disabled button can never
   * be focused to have it read out; a native `title` used to be both at once.
   */
  tip?: string | undefined;
  /** Escape hatch for layout only (margins, grid placement) — never for restyling. */
  className?: string;
}

/**
 * The app's button.
 *
 * Exists because actions were being drawn as links. Several still are: `<button class="link">`
 * appears throughout, which is a real button wearing a link's clothes — no padding, no hit
 * area beyond the text, and an underline on hover that promises a navigation that never
 * happens. That is the failure this component is meant to end. A link goes somewhere and
 * you can middle-click it; a button changes something and you cannot. Drawing one as the
 * other teaches people to distrust both.
 *
 * `type="button"` is the default here rather than the platform's `submit`: nothing in this
 * app posts a form, and a stray submit inside one reloads the page. Callers that genuinely
 * want to submit still pass `type="submit"` and it wins, since the spread comes after.
 *
 * Deliberately not wrapping anchors. A control that navigates should be a `<Link>` or an
 * `<a>` and should look like one — that distinction is the entire point of this component,
 * and a `<Button as="a">` would hand it straight back.
 */
export function Button({
  children,
  variant = 'secondary',
  tone = 'default',
  size = 'default',
  tip,
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn-${variant}`,
    tone === 'danger' ? 'btn-danger' : '',
    tone === 'neutral' ? 'btn-neutral' : '',
    size === 'small' ? 'btn-small' : '',
    size === 'large' ? 'btn-large' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} data-tip={tip} aria-description={tip} {...rest}>
      {children}
    </button>
  );
}
