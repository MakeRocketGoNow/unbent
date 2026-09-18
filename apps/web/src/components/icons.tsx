import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Book,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Film,
  Funnel,
  Hash,
  Image,
  Inbox,
  Link as LinkGlyph,
  List,
  Mail,
  Maximize2,
  Menu,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  SquareCheck,
  Star,
  StickyNote,
  Table2,
  Tag,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { normalizeContentType, type FieldType } from '@unbent/shared';

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
 * The two ways the note list is drawn, for the view toggle beside the filter and sort
 * icons: rows of entries, or a grid of a notebook's fields.
 */
export function ListViewIcon() {
  return <HeaderIcon icon={List} />;
}

export function TableViewIcon() {
  return <HeaderIcon icon={Table2} />;
}

/** The arrow beside a sorted column's heading, the way a spreadsheet draws it. */
export function SortDirectionIcon({ direction }: { direction: 'asc' | 'desc' }) {
  return <RowIcon icon={direction === 'asc' ? ArrowUp : ArrowDown} />;
}

/**
 * The navigation rail's collapse control: a panel with its left edge drawn, and an arrow
 * that says which way the next press moves it. The state is in the glyph *and* in the
 * button's name; the glyph alone would read the same to someone who cannot see it.
 */
export function RailToggleIcon({ open }: { open: boolean }) {
  return <HeaderIcon icon={open ? PanelLeftClose : PanelLeftOpen} />;
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
 * On a desktop it is a row on the rail's floor above the account, where Keep's web app puts
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
 * Sliders, for the fields row: a set of values to adjust, which is what the page behind
 * it is — one control per field rather than one list to pick from.
 */
export function FieldsIcon() {
  return <RowIcon icon={SlidersHorizontal} />;
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

/**
 * A rating takes the star rather than the hash, because the glyph is doing the same job
 * every other one here does: saying what the row is without a type in brackets. A rating
 * is a number under the hood, and the hash beside a row of stars would be the one glyph
 * in the column that described the storage instead of the value.
 */
export function FieldTypeIcon({ type, rating }: { type: FieldType; rating?: boolean }) {
  return <RowIcon icon={rating ? Star : FIELD_TYPE_ICONS[type]} />;
}

/**
 * What kind of file a note holds, labelling its name on the list row.
 *
 * The glyph says the kind so the name does not have to — an Evernote export carries PDFs
 * named `Menu Card`, and a row scanning for "that receipt photo" is looking for the
 * picture, not reading extensions. Four kinds are worth telling apart at a glance; the
 * rest share the paperclip, which is what every mail client has taught "a file" to look
 * like. Decided from the declared type, which is unverified — it chooses a picture here
 * and nothing more.
 */
export function AttachmentKindIcon({ contentType }: { contentType: string }) {
  const type = normalizeContentType(contentType);
  const icon = type.startsWith('image/')
    ? Image
    : type === 'application/pdf'
      ? FileText
      : type.startsWith('audio/')
        ? Music
        : type.startsWith('video/')
          ? Film
          : Paperclip;
  return <RowIcon icon={icon} />;
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

/**
 * Chevrons for nudging a chip one step earlier or later in an ordered list.
 *
 * Sized like `CloseIcon`, and for the same reason: they ride inside a chip beside its
 * label, so they answer to the word rather than to a touch target — the chip carries them.
 * The select-option editor gives each option a pair, to set the order the choices appear
 * in. Left is earlier and right is later, the reading-order direction the chips already
 * wrap in, rather than the up/down the field list uses for its one-per-row column.
 */
export function MoveEarlierIcon() {
  return <ChevronLeft size="0.85em" strokeWidth={2.5} aria-hidden="true" focusable="false" />;
}

export function MoveLaterIcon() {
  return <ChevronRight size="0.85em" strokeWidth={2.5} aria-hidden="true" focusable="false" />;
}

/**
 * Two overlapping rectangles, for copying text to the clipboard.
 *
 * Used beside a copiable value like the MCP server URL, where clicking copies. Small and
 * button-sized so it sits beside inline content without overwhelming it.
 */
export function CopyIcon() {
  return <Copy size="1em" strokeWidth={2} aria-hidden="true" focusable="false" />;
}

/**
 * Four arrows out of a corner, for opening an attachment at full size.
 *
 * On the inline PDF viewer's head, beside its other actions, and sized to sit in a small
 * icon button there. The same glyph the rich editor's widgets draw by hand below, so the
 * control reads as one thing wherever it appears.
 */
export function ExpandIcon() {
  return <Maximize2 size="1.1em" strokeWidth={2} aria-hidden="true" focusable="false" />;
}

/**
 * The same glyphs as markup, for the parts of the app that build their DOM by hand.
 *
 * The rich editor's image and PDF widgets live inside CodeMirror, and the attachment
 * viewer is a `<dialog>` built without React; neither can render a component. The path
 * data is lucide's own (`maximize-2` and `x`), copied rather than imported: the package
 * publishes each icon as a component and not as data, and shipping `react-dom/server` to
 * stringify two glyphs is the wrong trade. Kept in this file so it is the one seam still —
 * if the library changes, this is where the copies change with it.
 *
 * Sized in pixels rather than `em`. An image standing alone on its line has its font size
 * zeroed (`.cm-md-image-line`), which would zero an em-sized glyph with it.
 */
const EXPAND_PATHS = ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'];
const CLOSE_PATHS = ['M18 6 6 18', 'm6 6 12 12'];
const CHEVRON_LEFT_PATHS = ['m15 18-6-6 6-6'];
const CHEVRON_RIGHT_PATHS = ['m9 18 6-6-6-6'];
const DOWNLOAD_PATHS = ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'];
// lucide `copy` (its rect written as a path, since the helper draws paths) and `check`.
const COPY_PATHS = [
  'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
  'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
];
const CHECK_PATHS = ['M20 6 9 17l-5-5'];
// lucide `image-down`, its circle written as a path.
const IMAGE_DOWN_PATHS = [
  'M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21',
  'm14 19 3 3v-5.5',
  'm17 22 3-3',
  'M11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
];
// lucide `trash-2`.
const TRASH_PATHS = [
  'M3 6h18',
  'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
  'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
  'M10 11v6',
  'M14 11v6',
];

function iconMarkup(paths: readonly string[], size: number): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"',
    ` width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2"`,
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    ...paths.map((d) => `<path d="${d}"/>`),
    '</svg>',
  ].join('');
}

/** `ExpandIcon` as a string, for a button built with `innerHTML`. */
export function expandIconMarkup(): string {
  return iconMarkup(EXPAND_PATHS, 18);
}

/** Two sheets, for the attachment widgets' copy control; `checkIconMarkup` is its "done". */
export function copyIconMarkup(): string {
  return iconMarkup(COPY_PATHS, 18);
}

export function checkIconMarkup(): string {
  return iconMarkup(CHECK_PATHS, 18);
}

/** A picture with an arrow, for saving a web image into the note. */
export function imageDownIconMarkup(): string {
  return iconMarkup(IMAGE_DOWN_PATHS, 18);
}

/** A bin, for the attachment toolbar's remove control. */
export function trashIconMarkup(): string {
  return iconMarkup(TRASH_PATHS, 18);
}

/** A cross, for the attachment viewer's close button. */
export function closeIconMarkup(): string {
  return iconMarkup(CLOSE_PATHS, 22);
}

/** Chevrons, for paging the attachment viewer through a note's attachments. */
export function chevronLeftMarkup(): string {
  return iconMarkup(CHEVRON_LEFT_PATHS, 22);
}

export function chevronRightMarkup(): string {
  return iconMarkup(CHEVRON_RIGHT_PATHS, 22);
}

/** A tray with an arrow into it, beside the viewer's Download link. */
export function downloadIconMarkup(): string {
  return iconMarkup(DOWNLOAD_PATHS, 18);
}
