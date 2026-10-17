/**
 * Notebook templates: ready-made notebooks, each a name, an emoji, a purpose and its
 * custom fields, offered wherever a notebook is made.
 *
 * Fields are what make a notebook more than a folder, and they were only ever built by
 * hand, field by field, on the notebook's settings page. Someone new did not know what was
 * possible, and someone experienced rebuilt the same shapes again. A template is the shape
 * already built. It is notebook-based, not data-based: applying one makes the notebook and
 * its fields, and no notes.
 *
 * Each entry is a `NotebookDefinition` (the export's `notebooks/<slug>.yaml` shape) so
 * applying one is the definitions import that already exists (`POST /api/import/notebook`,
 * with `?create=1` so that it never merges into a notebook the person already has). What a
 * template adds is what the chooser shows before anything is made: a one-line description.
 *
 * Not the dev seed. `packages/seed` is a test fixture whose job is to break layouts, with
 * volume and edge cases; this is a product feature whose job is to look like a good
 * starting point. Neither imports from the other, even where a template and a seed
 * notebook share a shape, so changing one never changes the other by accident.
 *
 * This file ships in the public repo and every self-hosted instance offers it, so
 * everything in it is invented and generic. Option lists name no people, no places and no
 * services anyone might be subscribed to: the streaming service a watch list would name is
 * exactly the kind of detail that says something about whoever wrote it. "Where to watch"
 * is a text field for that reason, not a select of brands.
 *
 * A handful, not twenty, chosen for what people keep here: the paperless-office ones first,
 * since that is what an archive like this mostly holds, then two rated logs. Between them
 * every field type appears at least once, so the chooser doubles as a tour of what fields
 * can do; `notebook-templates.test.ts` holds that, and holds each entry to the schema the
 * import endpoint will check it against.
 */
import type { NotebookDefinition } from './notebook-file.js';

export interface NotebookTemplate extends NotebookDefinition {
  /** Stable, for keys and tests. Never sent to the server; the notebook is named by `name`. */
  id: string;
  emoji: string;
  /** What the notebook is for, as the chooser's card says it: one line, no full stop. */
  description: string;
  /** The sentence Auto-fill reads to decide what belongs here, written as a person would. */
  purpose: string;
}

export const NOTEBOOK_TEMPLATES: readonly NotebookTemplate[] = [
  {
    id: 'receipts',
    name: 'Receipts',
    emoji: '🧾',
    description: 'What you paid, where, and whether you have been paid back',
    purpose: 'Receipts for purchases and expenses, one per note, with the scan or photo attached.',
    fields: [
      { name: 'Vendor', type: 'text' },
      { name: 'Amount', type: 'number', currency: 'USD' },
      { name: 'Date', type: 'date' },
      {
        name: 'Category',
        type: 'select',
        options: ['Groceries', 'Dining', 'Travel', 'Office', 'Household', 'Health', 'Other'],
      },
      { name: 'Reimbursed', type: 'checkbox' },
    ],
  },
  {
    id: 'bills',
    name: 'Subscriptions & bills',
    emoji: '📅',
    description: 'Recurring charges, when they renew, and who to call about them',
    purpose:
      'Recurring bills and subscriptions: statements, renewal notices and the account details for each.',
    fields: [
      { name: 'Amount', type: 'number', currency: 'USD' },
      { name: 'Renews on', type: 'date' },
      { name: 'Cadence', type: 'select', options: ['Monthly', 'Quarterly', 'Yearly'] },
      { name: 'Account email', type: 'email' },
      { name: 'Support phone', type: 'phone' },
      { name: 'Autopay', type: 'checkbox' },
    ],
  },
  {
    id: 'warranties',
    name: 'Warranties & manuals',
    emoji: '🛠️',
    description: 'Proof of purchase, cover dates and the manual for things you own',
    purpose:
      'Warranties, manuals and proof of purchase for appliances, electronics and other things owned.',
    fields: [
      { name: 'Purchased on', type: 'date' },
      { name: 'Warranty ends', type: 'date' },
      { name: 'Store', type: 'text' },
      { name: 'Model number', type: 'text' },
      { name: 'Manual', type: 'url' },
    ],
  },
  {
    id: 'coupons',
    name: 'Coupons & gift cards',
    emoji: '🎟️',
    description: 'Codes and balances, sorted by when they run out',
    purpose: 'Coupons, vouchers and gift cards, with their codes and expiry dates.',
    fields: [
      { name: 'Code', type: 'text' },
      { name: 'Discount or balance', type: 'text' },
      { name: 'Expires', type: 'date' },
      { name: 'Used', type: 'checkbox' },
    ],
  },
  {
    id: 'restaurants',
    name: 'Restaurant log',
    emoji: '🍽️',
    description: 'Places you have eaten, what you thought, and whether to go back',
    purpose: 'Restaurant visits: what was ordered, how it was, and whether to return.',
    fields: [
      { name: 'Visited', type: 'date' },
      { name: 'Rating', type: 'number', scale: { max: 5, step: 0.5 } },
      { name: 'Would go again', type: 'checkbox' },
      {
        name: 'Good for',
        type: 'multiselect',
        options: ['Breakfast', 'Lunch', 'Dinner', 'Takeout', 'Groups', 'Date night'],
      },
    ],
  },
  {
    id: 'watch-list',
    name: 'Watch list',
    emoji: '🎬',
    description: 'Films and shows to watch, worked through by status',
    purpose: 'Films and series to watch or already watched, with a rating once seen.',
    fields: [
      { name: 'Type', type: 'select', options: ['Film', 'Series', 'Documentary'] },
      { name: 'Status', type: 'select', options: ['Want to watch', 'Watching', 'Watched'] },
      { name: 'Priority', type: 'select', options: ['High', 'Medium', 'Low'] },
      { name: 'Where to watch', type: 'text' },
      { name: 'Rating', type: 'number', scale: { max: 5, step: 0.5 } },
    ],
  },
];
