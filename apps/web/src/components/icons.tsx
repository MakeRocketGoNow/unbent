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
