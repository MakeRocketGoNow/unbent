import type { ReactNode } from 'react';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';

/**
 * When the disclosure starts open.
 *
 * `wide` — open where there is room, closed on a phone. For a row that is part of the note
 * and costs nothing at desktop width, but would push the content off a small screen.
 * `never` — closed until asked, at every width. For content that is unbounded, occasional,
 * or carries destructive controls.
 *
 * A policy rather than a boolean, because the breakpoint case needs two things that must
 * not drift apart: the `open` attribute *and* a `key` that remounts the element when the
 * breakpoint changes. Naming the policy lets this component own both. See the note on
 * `key` below for why that pairing is not optional.
 */
/**
 * `always` opens the panel whatever the width, and re-opens it if the caller switches to
 * it later: the attachments panel asks for it the moment a note has files that are no
 * longer linked, which is the case worth putting on screen.
 */
export type DisclosureDefault = 'wide' | 'never' | 'always';

export interface DisclosureProps {
  /** What the disclosure is hiding, stated. See the grammar note above. */
  summary: ReactNode;
  children: ReactNode;
  /** Defaults to `never` — the safe choice for content of unknown size. */
  defaultOpen?: DisclosureDefault;
  /** Escape hatch for the container box only — border, padding, where it sits. Never the summary. */
  className?: string;
}

/**
 * The app's collapsible section.
 *
 * Exists because this codebase had three hand-rolled `<details>` and no component, so the
 * convention lived in CSS comments and was copied by hand. It drifted, as copied conventions
 * do: the note's filing row drew a custom chevron on the right with a 36px target, while the
 * attachments panel directly beneath it kept the browser's native triangle on the left with a
 * 19px one. Two rows, stacked, pointing opposite ways. That is the failure this ends, and it
 * is the same failure `Button` ended for `<button class="link">`.
 *
 * The right-hand chevron won on evidence rather than taste: the Android app's filing row
 * (`NoteScreen.kt`) already draws `ArrowDropDown` at the right edge and lets the tags truncate
 * to keep it there, so the native left triangle was the odd one out across the whole product,
 * not just the web.
 *
 * **The summary states the value.** A noun is added only when the value cannot identify
 * itself. `Coupons  #Groceries` needs none — a notebook name and hashed tags say
 * what they are. `(4)` does, so it is `Attachments (4)`. `Tags` earns its noun because when
 * nothing is filtering, the value is a bare count.
 *
 * **Anything in the summary that should sit hard right gets `margin-left: auto`.** There is no
 * `trailing` slot: `.disclosure-label` is a flex row, so that one line is the whole mechanism,
 * and it is already what the sidebar's active-tag chip and tag count do. A prop would be a
 * second spelling of it, and it would force right-alignment onto the attachments warning,
 * which reads as a sentence rather than a chip.
 *
 * Deliberately does not take `onToggle`, `id`, or a class for the summary. A disclosure whose
 * open state something else depends on is not this component — it is a panel with state, and
 * it should hold that state in React rather than in a DOM attribute.
 *
 * Note for tests: jsdom ships no `matchMedia`, so any test that renders a `Disclosure` has to
 * stub it. `useMediaQuery.test.ts` has the controllable version worth copying.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = 'never',
  className,
}: DisclosureProps) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const byBreakpoint = defaultOpen === 'wide';
  const always = defaultOpen === 'always';

  return (
    <details
      /*
         `open` is a default here, not a controlled value, and that is the whole subtlety.

         It is a DOM attribute the user can change by clicking, and React will not re-assert
         it on a later render — so once someone has toggled the element, a new default has no
         way in. Changing the `key` deletes the host node and builds a fresh one, which is the
         only thing that makes the new default take.

         Keyed *only* for `wide`. Keying a `never` disclosure would collapse a panel the user
         had opened every time the viewport crossed the breakpoint — a rotation closing the
         attachments list out from under them.
      */
      key={always ? 'always' : byBreakpoint ? String(isMobile) : undefined}
      className={className ? `disclosure ${className}` : 'disclosure'}
      /* `undefined` rather than `false`, so the attribute stays off the element entirely. */
      open={always ? true : byBreakpoint ? !isMobile : undefined}
    >
      <summary>
        {/* The label is a separate box because that is where truncation lives: it yields, so
            the chevron beside it never has to. See the rule in styles.css for what happens
            to a squeezed chevron. */}
        <span className="disclosure-label">{summary}</span>
      </summary>
      {children}
    </details>
  );
}
