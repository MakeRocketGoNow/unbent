import type { ReactNode } from 'react';

/**
 * The shared geometry every icon in this app is drawn on.
 *
 * A 24×24 box, `currentColor` at stroke width 2, round caps and joins, sized in `em` so it
 * inherits the surrounding font-size the way a letter does. Pass it paths and the result
 * matches everything else.
 *
 * Inline rather than from an icon library: this is a handful of icons in a codebase whose
 * other controls are letters (B, I, S, H1), and a dependency would still not draw those.
 * That is a judgement about the current scale and not a principle — see the Icons section
 * of AGENTS.md, which says to propose the switch rather than quietly adding more paths once
 * the count justifies it. This wrapper is the seam that keeps the switch cheap: every icon
 * passes through it, so adopting a library means changing this file rather than hunting SVG
 * across the codebase.
 *
 * It lives here rather than in `EditorToolbar`, where it was written, because the note list
 * header now draws icons too and importing them from the editor's toolbar would have said
 * they were the toolbar's.
 */
export function ToolbarIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.05em"
      height="1.05em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * The list header's controls.
 *
 * Sized a touch larger than the toolbar's, because these sit alone in 44px squares rather
 * than in a dense row of letterforms: at 1.05em a lone icon in a 2.75rem target reads as an
 * afterthought in the middle of it.
 */
function HeaderIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.25em"
      height="1.25em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * An icon that labels a row of text rather than standing alone in a button.
 *
 * Sized against the label it sits beside rather than against a touch target: the whole row
 * is the target, so the glyph only has to match the words. Muted by the row it is in, since
 * it names the row rather than competing with it.
 */
function RowIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.15em"
      height="1.15em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A magnifier, for opening the search field. */
export function SearchIcon() {
  return (
    <HeaderIcon>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </HeaderIcon>
  );
}

/**
 * A funnel, for the filter sheet.
 *
 * The funnel rather than the three-slider "tune" glyph: sliders say adjust, and these
 * controls narrow. It is also what the Android app draws (`ic_filter.xml`), and the two
 * halves of one product should not name the same surface with different pictures.
 */
export function FilterIcon() {
  return (
    <HeaderIcon>
      <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
    </HeaderIcon>
  );
}

/**
 * Two opposed arrows, for the sort menu.
 *
 * Not the A–Z or 1–9 variants: the list sorts by date as often as by title, and an icon
 * naming one of them would be wrong four times out of five. Direction is what all five
 * options have in common.
 */
export function SortIcon() {
  return (
    <HeaderIcon>
      <path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5" />
      <path d="M17 20V4m0 0-3.5 3.5M17 4l3.5 3.5" />
    </HeaderIcon>
  );
}

/**
 * Three lines, for the drawer.
 *
 * The universal glyph for "there is a panel of places behind this", and the one the Android
 * app's own top bar draws in the same corner. Nothing else would be recognised as quickly,
 * which is the whole job of a control that hides navigation.
 */
export function MenuIcon() {
  return (
    <HeaderIcon>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </HeaderIcon>
  );
}

/**
 * A plus, for the button that makes a new note.
 *
 * A bare cross rather than a document-with-a-plus: the button is a filled circle in the
 * corner of a list of notes, so what it would make is not in question, and the smaller
 * shape reads at a glance where a detailed one would turn to mush.
 */
export function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.5em"
      height="1.5em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * A luggage label, for the tags row.
 *
 * Drawn stroked rather than filled, unlike the Android drawable it mirrors: every icon in
 * this app is an outline at stroke width 2, and a solid shape among them reads as a
 * different kind of thing rather than as the same row's sibling. The punched hole is the
 * part that makes it a tag and not a chevron, so it survives the translation.
 */
export function TagIcon() {
  return (
    <RowIcon>
      <path d="M3 3h7.2c.3 0 .6.1.8.4l9.6 9.6c.5.5.5 1.2 0 1.7l-5.9 5.9c-.5.5-1.2.5-1.7 0L3.4 11a1.2 1.2 0 0 1-.4-.8V3Z" />
      <circle cx="7.3" cy="7.3" r="1.3" />
    </RowIcon>
  );
}

/**
 * A calendar, for the dates row.
 *
 * The same 24×24 grid and stroke weight as the tag beside it, which is what makes the two
 * rows read as siblings — Android's drawable says the same thing in its own comment.
 */
export function CalendarIcon() {
  return (
    <RowIcon>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </RowIcon>
  );
}

/**
 * A cross, for removing one filter from a chip.
 *
 * Small: it rides inside a chip beside the filter's name, so it is sized against the label
 * rather than against a touch target — the whole chip is the target.
 */
export function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="0.85em"
      height="0.85em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
