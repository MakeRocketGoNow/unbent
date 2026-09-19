/**
 * Frontmatter codec — the contract the entire disaster-recovery story rests on.
 *
 * In D1, a note's title/tags/timestamps live in real columns and `body` holds markdown
 * WITHOUT frontmatter. Frontmatter exists only in the export format, where it is generated
 * from those columns. Re-importing an exported note must reconstruct the columns exactly,
 * so `parse(serialize(note))` is required to be the identity function. See the round-trip
 * tests in frontmatter.test.ts.
 *
 * Uses `yaml` rather than `js-yaml`: titles containing colons, leading quotes, or newlines
 * need correct quoting on the way out, and `yaml` gets that right by default.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isReservedFieldName, type FieldValue } from './fields.js';

export interface NoteFrontmatter {
  id: string;
  title: string;
  created: Date;
  updated: Date;
  tags: string[];
  /** Evernote-style notebook name. Omitted when absent. */
  notebook?: string;
  /** Original URL for a clipped or bookmarked note. Omitted when absent. */
  source?: string;
  /**
   * Custom field values keyed by field name, written as ordinary top-level keys so any
   * other Markdown tool reads them as properties. Numbers and booleans are YAML scalars;
   * dates are `YYYY-MM-DD` strings. Omitted when there are none.
   */
  fields?: Record<string, FieldValue>;
}

export interface ParsedNote extends NoteFrontmatter {
  body: string;
}

/** Opening/closing `---` fences, tolerating a BOM, CRLF, and trailing spaces on the fence. */
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

/** Epoch ms -> `2024-01-15T09:30:00Z`. Avoids the `.000` that toISOString always emits. */
function toIso(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new FrontmatterError('Invalid date');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseDate(value: unknown, field: string): Date {
  // The `yaml` package auto-parses unquoted ISO-8601 timestamps into Date objects.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new FrontmatterError(`Invalid ${field}`);
    return value;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new FrontmatterError(`Invalid ${field}: ${value}`);
    return d;
  }
  throw new FrontmatterError(`Missing or invalid ${field}`);
}

/**
 * Render a note as its markdown file — YAML frontmatter followed by the body.
 *
 * Timestamps are emitted unquoted so they read as dates in any YAML parser; every other
 * scalar is left to `yaml` to quote as needed.
 */
export function serialize(note: ParsedNote): string {
  if (!note.id) throw new FrontmatterError('Note id is required');

  const fm = stringifyYaml(
    {
      id: note.id,
      title: note.title,
      created: toIso(note.created),
      updated: toIso(note.updated),
      tags: note.tags,
      ...(note.notebook ? { notebook: note.notebook } : {}),
      // Omitted rather than emitted empty: most notes have no source.
      ...(note.source ? { source: note.source } : {}),
      // After the keys above so a reader sees the note's own metadata first. The name
      // schema already refuses reserved names; filtering again here means a stray value
      // can never overwrite the id or the title on the way out.
      ...Object.fromEntries(
        Object.entries(note.fields ?? {}).filter(([k]) => !isReservedFieldName(k)),
      ),
    },
    {
      lineWidth: 0, // never fold long titles onto a second line
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
    },
  );

  // `tags: []` round-trips as an empty array; a flow sequence keeps it on one line.
  return `---\n${fm}---\n\n${note.body}`;
}

/**
 * Parse an exported note back into its columns. Throws FrontmatterError when it has no
 * frontmatter or is missing required fields — an import should surface that note as failed
 * rather than silently inventing an id or timestamp.
 */
export function parse(source: string): ParsedNote {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) throw new FrontmatterError('No frontmatter block found');

  const [, yamlBlock, rest] = match;

  let data: unknown;
  try {
    data = parseYaml(yamlBlock ?? '');
  } catch (cause) {
    throw new FrontmatterError(`Malformed YAML frontmatter: ${(cause as Error).message}`);
  }
  if (typeof data !== 'object' || data === null) {
    throw new FrontmatterError('Frontmatter is not a mapping');
  }

  const raw = data as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || raw['id'] === '') {
    throw new FrontmatterError('Missing required field: id');
  }

  // A title that is only digits parses as a number; coerce rather than reject.
  const title =
    raw['title'] === undefined || raw['title'] === null ? '' : String(raw['title']);

  let tags: string[] = [];
  if (Array.isArray(raw['tags'])) {
    tags = raw['tags'].map((t) => String(t));
  } else if (typeof raw['tags'] === 'string' && raw['tags'] !== '') {
    tags = [raw['tags']];
  }

  // Every other key is a custom field. Known keys are claimed above, and reserved names
  // are dropped case-insensitively so a hand-written `Title:` cannot come back as a field
  // called Title. A list of scalars is a multi-select's value, read as strings. Maps and
  // nested lists are not values a field can hold; they are left behind rather than
  // stringified into something that would round-trip as text.
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isReservedFieldName(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = value;
    } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
      fields[key] = value.toISOString().slice(0, 10);
    } else if (Array.isArray(value) && value.every(isScalar)) {
      fields[key] = value.map(String);
    }
  }

  return {
    id: raw['id'],
    title,
    created: parseDate(raw['created'], 'created'),
    updated: parseDate(raw['updated'], 'updated'),
    tags,
    ...(typeof raw['notebook'] === 'string' && raw['notebook']
      ? { notebook: raw['notebook'] }
      : {}),
    ...(typeof raw['source'] === 'string' && raw['source'] ? { source: raw['source'] } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    // serialize() writes exactly one blank line after the fence; strip it back off.
    body: (rest ?? '').replace(/^\r?\n/, ''),
  };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** True when the document opens with a frontmatter fence. */
export function hasFrontmatter(source: string): boolean {
  return FRONTMATTER_RE.test(source);
}
