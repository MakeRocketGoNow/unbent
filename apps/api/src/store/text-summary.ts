import { findDates, findNumbers, type FoundNumber } from '@unbent/shared';

/**
 * A text layer's one-line summary, for MCP's `get_note` and `list_notes` (MAK-177): what
 * the document opens with, then the facts someone filing it wants — the total, the dates,
 * an order or invoice number, the other amounts — found anywhere in the text.
 *
 * It used to be the first 280 characters of the text alone. On a receipt that is the
 * shop's address and the member number; the total is at the bottom, and about a third of
 * the notes in a backfill over receipts needed a `get_attachment_text` call each for the
 * date or the total the excerpt cut off. A vision reading has a summary the model wrote;
 * a text layer is never shown to a model, and asking one for every PDF was proposed and
 * turned down, for its cost per file on an archive of thousands (MAK-178). So this is
 * found by pattern, with auto-fill's own finders, when the summary is read: no model, no
 * column, nothing to backfill, and every file already stored gets it.
 *
 * What a pattern cannot do, and a model would: name the party when the document opens
 * with an address block rather than a letterhead, and say which amount is the total on
 * a document that does not label it. The labelled one is named; otherwise the amounts
 * are listed, and get_attachment_text is still there for the rest.
 *
 * The parts are joined with ` · `, labelled, and each is left out when the text has
 * none: "Acme Hardware #12 1234 Main St… · Total: $18.67 · Date: 2026-03-02 ·
 * Order #112-0042", or "… · Dates: 2026-01-01, 2026-03-31 · Amounts: $1,200.00" where
 * nothing is labelled the total.
 */

/**
 * The most of a text layer the summary is found in. The facts are on the first page or
 * two of a receipt, an invoice or a statement; reading further finds more of a long
 * statement's line items, which only lengthen the list. Read with `substr` in the query,
 * so a long scan never crosses into the object whole, and bounded for the page: a page of
 * summaries is a hundred notes at ten files each at most, and this times that is what the
 * object holds while it answers.
 */
export const TEXT_SUMMARY_SOURCE_CHARS = 8_000;

/** The opening's share of the line. Enough for a letterhead and a heading. */
const OPENING_CHARS = 150;
/**
 * How many dates are named, and how many amounts when no total is labelled; more is a
 * list, not a summary. Once a total is found the other amounts are left out: on a receipt
 * they are its lines' prices and its subtotal, which the opening shows already or nobody
 * filing it wants.
 */
const DATES_NAMED = 2;
const AMOUNTS_NAMED = 3;

/**
 * A line that labels a total. "Subtotal" never matches `\btotal`, and `NOT_TOTAL` turns
 * away the totals that are not the amount paid: "Sub total", "Total tax", "Total savings",
 * "Total items 5", and a statement's period summary — "Total fees charged this period",
 * "Total interest charged", "Minimum amount due", "Past due".
 *
 * `PAID` is the labels that say outright the figure is what was owed or paid, and one of
 * them beats a bare "Total" wherever the two fall: a card statement prints its "New
 * balance" near the top and its period's totals below, and the last bare total there is
 * a fee line's $0.00.
 */
const TOTAL = /\b(?:grand\s+total|total(?:\s+(?:due|amount|paid|charged|price|cost))?|amount\s+(?:due|paid)|balance\s+due|new\s+balance)\b/i;
const PAID = /\b(?:grand\s+total|total\s+(?:amount\s+)?(?:due|paid|charged)|amount\s+(?:due|paid)|balance\s+due|new\s+balance)\b/i;
/**
 * What a total line can be a total *of* without being the amount paid. Turned away only
 * when the word qualifies "total" — "Total tax", "Tax total", "Total number of items" —
 * and not anywhere on the line, which refused "Total (incl. tax) $4.95" and "Total with
 * tip $48.00", the very lines a restaurant receipt ends on. "Total tax included" is the
 * one reading of "total tax" that is the amount paid.
 */
const TOTAL_OF =
  'tax(?:es)?|tips?|discounts?|savings?|items?|qty|quantity|points|fees?|interest|payments?|credits?|purchases?|advances?|transactions?';
const NOT_TOTAL = new RegExp(
  [
    String.raw`\bsub\s*-?\s*total\b`,
    String.raw`\b(?:minimum|past|saved|savings)\b`,
    String.raw`\bmin\.`,
    String.raw`\btotal\s+(?:number\s+of\s+)?(?:${TOTAL_OF})\b(?!\s+incl)`,
    String.raw`\b(?:${TOTAL_OF})\s+total\b`,
  ].join('|'),
  'i',
);

/**
 * An order or invoice number: after a marker that says it is one — `#`, "no.", "number",
 * "id", or a colon — or, with none, a figure straight after the word ("Invoice 2026-0117",
 * "Order 55821"). Without a marker the value must start with a digit and run to four
 * characters, so "Order total" and "Invoice date" are not numbers and "Order 12 items" is
 * not an order; with one it must still hold a digit. Order and invoice only: a member,
 * account or card number is the kind of thing a summary should not repeat.
 */
const ORDER = /\b(order|invoice)(?:\s*(?:#|no\.|no\b|number|num\.?|id\b|:)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,29})|\s+(\d[\d-]{3,29}))\b/gi;

/** Cut to `max` at a word, with an ellipsis when anything was cut. */
function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What the document opens with, as one line: Markdown's marks and links undone (the text
 * layer is Workers AI's Markdown, or pdf.js's plain text), addresses dropped — a URL
 * header is what a printed web page opens with, and it names nothing — and lines with no
 * word in them skipped, which is a scan's run of rules and stray digits.
 */
function openingOf(text: string): string {
  return clipWords(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<?\b(?:https?:\/\/|www\.)\S+/gi, '')
      .split('\n')
      .map((line) =>
        line
          .replace(/^[\s#>*+|-]+/, '')
          .replace(/[|*_]+/g, ' ')
          .trim(),
      )
      .filter((line) => /\p{L}{2}/u.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
    OPENING_CHARS,
  );
}

/** The last amount on a line: the label is first and the figure after it, as tables print them too. */
const lastAmount = (line: string): FoundNumber | undefined =>
  findNumbers(line)
    .filter((n) => n.amount)
    .sort((a, b) => a.index - b.index)
    .at(-1);

/**
 * The amount a total line labels. The last such line in the text wins, because a receipt
 * prints its subtotal, its tax and then what was paid — the last `PAID` line when there
 * is one, the last bare total otherwise. A label with its figure on the line below — how
 * some conversions lay out a two-column table — takes that figure when the line holds
 * nothing else.
 */
function totalIn(text: string): FoundNumber | undefined {
  const lines = text.split('\n');
  let paid: FoundNumber | undefined;
  let total: FoundNumber | undefined;
  lines.forEach((line, i) => {
    if (!TOTAL.test(line) || NOT_TOTAL.test(line)) return;
    let found = lastAmount(line);
    if (!found) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      if (next && next.replace(/[\s|*_]/g, '').length <= 20) found = lastAmount(next);
    }
    if (!found) return;
    if (PAID.test(line)) paid = found;
    else total = found;
  });
  return paid ?? total;
}

/**
 * The amounts of a text with no labelled total, in the order written: those with a currency mark when
 * the text writes any, since a bare fraction is as often a weight, a rate or an item's
 * price; the fractions otherwise.
 *
 * Found a line at a time, not over the whole text. `findNumbers` keeps one finding per
 * value, the first, which is right for auto-fill's candidates and wrong here: a receipt's
 * "ITEM 3" took the value 3 and hid the "$3.00" of its savings line further down.
 */
function amountsIn(text: string): FoundNumber[] {
  const lists = { marked: [] as FoundNumber[], fractions: [] as FoundNumber[] };
  const seen = { marked: new Set<number>(), fractions: new Set<number>() };
  for (const line of text.split('\n')) {
    for (const n of findNumbers(line).sort((a, b) => a.index - b.index)) {
      if (!n.amount) continue;
      const kind = /^[$€£]/.test(n.raw) ? 'marked' : 'fractions';
      if (seen[kind].has(n.value)) continue;
      seen[kind].add(n.value);
      lists[kind].push(n);
    }
  }
  return lists.marked.length > 0 ? lists.marked : lists.fractions;
}

function orderIn(text: string): string | undefined {
  for (const m of text.matchAll(ORDER)) {
    const value = (m[2] ?? m[3])!;
    if (!/\d/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    const kind = m[1]!.toLowerCase() === 'order' ? 'Order' : 'Invoice';
    return `${kind} #${value}`;
  }
  return undefined;
}

/** The summary of a text layer, or `''` when the text says nothing this can name. */
export function textSummary(text: string): string {
  const total = totalIn(text);
  const dates = findDates(text)
    .sort((a, b) => a.index - b.index)
    .slice(0, DATES_NAMED)
    .map((d) => d.iso);
  const order = orderIn(text);
  const named = total ? [] : amountsIn(text).slice(0, AMOUNTS_NAMED).map((n) => n.raw);

  return [
    openingOf(text),
    total && `Total: ${total.raw}`,
    dates.length > 0 && `${dates.length === 1 ? 'Date' : 'Dates'}: ${dates.join(', ')}`,
    order,
    named.length > 0 && `Amounts: ${named.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
