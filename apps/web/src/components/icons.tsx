import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpDown,
  Calendar,
  Funnel,
  Hash,
  Link as LinkGlyph,
  List,
  Mail,
  Menu,
  Phone,
  Plus,
  Search,
  SquareCheck,
  Tag,
  Type,
  X,
} from 'lucide-react';
import type { FieldType } from '@unbent/shared';

/**
 * Every icon in this app passes through this file.
 *
 * The glyphs come from lucide. They were hand-drawn until the fifteenth one: the first
 * dozen were a few straight lines each and a library would not have drawn them better, but
 * the tag with its punched hole and the calendar were traced from Android's drawables by
 * eye, which is exactly the work an icon set exists to save — and custom field types then
 * asked for eight more. AGENTS.md records the same arc. lucide rather than Material because
 * its defaults are the geometry this file already had: a 24×24 box, `currentColor` at
 * stroke width 2, round caps and joins.
 *
 * Still one seam on purpose. Callers import named components from here and never lucide
 * directly, so the sizes stay consistent (an icon is sized against what it sits beside,
 * not against a pixel grid — see the three wrappers) and swapping the library again would
 * be this file rather than a hunt across the codebase.
 */

/**
 * The editor toolbar's own glyphs, which are paths rather than library icons: bold, italic
 * and the rest are letters in this toolbar, and the few real icons beside them
 * (`EditorToolbar.tsx`) are drawn to match those letters rather than a library's weight.
 * Sized in `em` so it inherits the surrounding font-size the way a letter does.
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
function HeaderIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size="1.25em" strokeWidth={2} aria-hidden="true" focusable="false" />;
}

/**
 * An icon that labels a row of text rather than standing alone in a button.
 *
 * Sized against the label it sits beside rather than against a touch target: the whole row
 * is the target, so the glyph only has to match the words. Muted by the row it is in, since
 * it names the row rather than competing with it.
 */
export function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size="1.15em" strokeWidth={2} aria-hidden="true" focusable="false" />;
}

/** A magnifier, for opening the search field. */
export function SearchIcon() {
  return <HeaderIcon icon={Search} />;
}

/**
 * A funnel, for the filter sheet.
 *
 * The funnel rather than the three-slider "tune" glyph: sliders say adjust, and these
 * controls narrow. It is also what the Android app draws (`ic_filter.xml`), and the two
 * halves of one product should not name the same surface with different pictures.
 */
export function FilterIcon() {
  return <HeaderIcon icon={Funnel} />;
}

/**
 * Two opposed arrows, for the sort menu.
 *
 * Not the A–Z or 1–9 variants: the list sorts by date as often as by title, and an icon
 * naming one of them would be wrong four times out of five. Direction is what all five
 * options have in common.
 */
export function SortIcon() {
  return <HeaderIcon icon={ArrowUpDown} />;
}

/**
 * Three lines, for the drawer.
 *
 * The universal glyph for "there is a panel of places behind this", and the one the Android
 * app's own top bar draws in the same corner. Nothing else would be recognised as quickly,
 * which is the whole job of a control that hides navigation.
 */
export function MenuIcon() {
  return <HeaderIcon icon={Menu} />;
}

/**
 * A plus, for the button that makes a new note.
 *
 * A bare cross rather than a document-with-a-plus: the button is a filled circle in the
 * corner of a list of notes, so what it would make is not in question, and the smaller
 * shape reads at a glance where a detailed one would turn to mush.
 */
export function PlusIcon() {
  return <Plus size="1.5em" strokeWidth={2} aria-hidden="true" focusable="false" />;
}

/**
 * A luggage label, for the tags row.
 *
 * Stroked, like every icon here, unlike the filled Android drawable it mirrors: a solid
 * shape among outlines reads as a different kind of thing rather than as the same row's
 * sibling. The punched hole is what makes it a tag and not a chevron.
 */
export function TagIcon() {
  return <RowIcon icon={Tag} />;
}

/**
 * A calendar, for the dates row.
 *
 * The same grid and stroke weight as the tag beside it, which is what makes the two rows
 * read as siblings — Android's drawable says the same thing in its own comment.
 */
export function CalendarIcon() {
  return <RowIcon icon={Calendar} />;
}

/**
 * One glyph per custom field type, labelling a field's row.
 *
 * The glyph says the type so the label does not have to: "Amount" beside a hash reads
 * as a number without "(number)" after it. Drawn through `RowIcon` because that is what
 * these are — a picture beside a row of text, sized against the words.
 */
const FIELD_TYPE_ICONS: Record<FieldType, LucideIcon> = {
  text: Type,
  number: Hash,
  date: Calendar,
  checkbox: SquareCheck,
  url: LinkGlyph,
  email: Mail,
  phone: Phone,
  select: List,
};

export function FieldTypeIcon({ type }: { type: FieldType }) {
  return <RowIcon icon={FIELD_TYPE_ICONS[type]} />;
}

/**
 * A cross, for removing one filter from a chip.
 *
 * Small and a touch heavier: it rides inside a chip beside the filter's name, so it is
 * sized against the label rather than against a touch target — the whole chip is the
 * target — and at that size stroke width 2 goes faint.
 */
export function CloseIcon() {
  return <X size="0.85em" strokeWidth={2.5} aria-hidden="true" focusable="false" />;
}
