/**
 * The seed's notebooks, in the shape `POST /api/import/notebook` takes — the same
 * definition an export writes to `notebooks/<slug>.yaml`.
 *
 * The five without fields are the showcase's. The five with fields are modelled on the
 * kinds of notebook this app is actually used for — a log with a star rating, a list
 * worked through by status, codes that expire, contacts, receipts with scans — so a
 * feature built for custom fields has something real-shaped to run against: the table
 * view, sorting and filtering by field, a field's settings page, auto-fill's prompt.
 *
 * Between them they hold every field type; a number plain, as a rating at both steps and
 * as a currency; selects long and short; and a notebook with no fields at all. The names,
 * options and every value are invented, with one deliberate exception: the field shapes,
 * and option lists that say nothing about anyone — a watch list's Type, Status and
 * Priority, a Yes/Maybe/No — were taken from a real account's notebooks, because those are
 * what the features have to handle. Nothing else was: no notebook name, no value, and no
 * option list that names people, places or services, because an option list can be a
 * list of people.
 */
export const NOTEBOOKS = [
  { name: 'Recipes', fields: [] },
  { name: 'Projects', fields: [] },
  { name: 'Reading', fields: [] },
  { name: 'Travel', fields: [] },
  { name: 'Home', fields: [] },
  {
    name: 'Restaurants',
    emoji: '🍽️',
    purpose: 'Meals out: where, what, and whether it was worth going back for.',
    fields: [
      { name: 'Restaurant', type: 'text' },
      { name: 'Date', type: 'date' },
      { name: 'Rating', type: 'number', scale: { max: 5, step: 1 } },
      { name: 'Review', type: 'text' },
      { name: 'Would Get Again', type: 'select', options: ['Yes', 'Maybe', 'No'] },
    ],
  },
  {
    name: 'Watch List',
    emoji: '🎬',
    purpose: 'Films, series and talks to watch, being watched, or watched.',
    fields: [
      {
        name: 'Type',
        type: 'select',
        options: ['Movie', 'TV Series', 'Documentary', 'Docuseries', 'Comedy Special', 'Talk / Short'],
      },
      { name: 'Status', type: 'select', options: ['Want to Watch', 'Watching', 'Watched', 'Rewatch', 'Gave Up'] },
      { name: 'Priority', type: 'select', options: ['Must Watch', 'Want To', 'Someday', 'Maybe'] },
      {
        name: 'Where to Watch',
        type: 'select',
        options: ['Streaming', 'Rental', 'Library', 'Free online', 'Theater', 'Broadcast'],
      },
      { name: 'Recommended By', type: 'text' },
      { name: 'URL', type: 'url' },
      // Half-step, so the one rating that allows a half star is exercised somewhere.
      { name: 'Rating', type: 'number', scale: { max: 5, step: 0.5 } },
      // A plain number — no scale, no currency — the one variant of `number` nothing else
      // here has. A series' total runs past a thousand, so grouping is exercised too.
      { name: 'Runtime (min)', type: 'number' },
    ],
  },
  {
    name: 'Coupons',
    emoji: '🏷️',
    fields: [
      { name: 'Code', type: 'text' },
      { name: 'Discount', type: 'text' },
      { name: 'Date Added', type: 'date' },
      { name: 'Expiration', type: 'date' },
      { name: 'Used', type: 'checkbox' },
      { name: 'Notes', type: 'text' },
    ],
  },
  {
    name: 'Contacts',
    emoji: '📇',
    purpose: 'People and businesses worth remembering, usually from a card or an invoice.',
    fields: [
      { name: 'Name', type: 'text' },
      { name: 'Company', type: 'text' },
      { name: 'Role', type: 'text' },
      { name: 'Email', type: 'email' },
      { name: 'Phone', type: 'phone' },
      { name: 'Website', type: 'url' },
      {
        name: 'Category',
        type: 'multiselect',
        options: ['Home', 'Auto', 'Food & Drink', 'Outdoors', 'Tech', 'Trades', 'Finance', 'Health'],
      },
      { name: 'Met', type: 'date' },
    ],
  },
  {
    name: 'Receipts',
    emoji: '🧾',
    purpose: 'Receipts and invoices, kept for returns, warranties and reimbursement.',
    fields: [
      { name: 'Vendor', type: 'text' },
      { name: 'Amount', type: 'number', currency: 'USD' },
      { name: 'Date', type: 'date' },
      { name: 'Category', type: 'select', options: ['Groceries', 'Hardware', 'Office', 'Auto', 'Dining', 'Other'] },
      { name: 'Reimbursed', type: 'checkbox' },
    ],
  },
];
