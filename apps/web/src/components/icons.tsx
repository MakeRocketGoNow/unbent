import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Book,
  Calendar,
  Check,
  Funnel,
  Hash,
  Inbox,
  Link as LinkGlyph,
  List,
  Mail,
  Menu,
  Pencil,
  Phone,
  Plus,
  Search,
  Settings,
  SquareCheck,
  StickyNote,
  Tag,
  Trash2,
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

/*
   The drawer's rows.

   Every row gets a glyph, as every drawer people arrive from gives it: a column of bare
   words is scanned by reading, and a column with a picture beside each word is scanned by
   looking. They are `RowIcon`s — sized to the label, muted by the row — and they name
   what the row is rather than decorate it, which is why each notebook gets the same book
   rather than a picture of its own.
*/
export function NotesRowIcon() {
  return <RowIcon icon={StickyNote} />;
}

export function InboxRowIcon() {
  return <RowIcon icon={Inbox} />;
}

export function NotebookRowIcon() {
  return <RowIcon icon={Book} />;
}

export function PlusRowIcon() {
  return <RowIcon icon={Plus} />;
}

export function TrashRowIcon() {
  return <RowIcon icon={Trash2} />;
}

export function SettingsRowIcon() {
  return <RowIcon icon={Settings} />;
}

/*
   The label editor's controls: the two a resting row offers and the two an editing row
   offers. `HeaderIcon`-sized, because each sits alone in a 44px button rather than
   beside a word — the pencil is the row's one control and the check, cross and trash
   can are the editing row's. Keep's "Edit labels" screen draws exactly this set.
*/
export function PencilIcon() {
  return <HeaderIcon icon={Pencil} />;
}

export function CheckIcon() {
  return <HeaderIcon icon={Check} />;
}

export function CancelIcon() {
  return <HeaderIcon icon={X} />;
}

export function TrashIcon() {
  return <HeaderIcon icon={Trash2} />;
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
 * A gear, for the way to Settings.
 *
 * On a desktop it sits in the topbar beside the avatar, which is where Keep's web app puts
 * its own: Settings is about the app, and the avatar menu is about the account, and one
 * gear beside one avatar keeps the two from being confused for each other.
 */
export function SettingsIcon() {
  return <HeaderIcon icon={Settings} />;
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

/** Arrows for the two buttons that reorder a list one step at a time. */
export function MoveUpIcon() {
  return <RowIcon icon={ArrowUp} />;
}

export function MoveDownIcon() {
  return <RowIcon icon={ArrowDown} />;
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
