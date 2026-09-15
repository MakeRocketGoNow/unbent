import { describe, expect, it } from 'vitest';
import { FrontmatterError, hasFrontmatter, parse, serialize, type ParsedNote } from './frontmatter.js';

const base: ParsedNote = {
  id: '01912f3c-1234-7890-abcd-ef0123456789',
  title: 'Meeting notes',
  created: new Date('2024-01-15T09:30:00Z'),
  updated: new Date('2024-03-02T11:04:00Z'),
  tags: ['work', 'planning'],
  body: 'Some **markdown** here.\n',
};

/** The identity property the export/re-import path depends on. */
function roundTrip(note: ParsedNote): ParsedNote {
  return parse(serialize(note));
}

function expectRoundTrip(note: ParsedNote): void {
  const out = roundTrip(note);
  expect(out.id).toBe(note.id);
  expect(out.title).toBe(note.title);
  expect(out.created.getTime()).toBe(note.created.getTime());
  expect(out.updated.getTime()).toBe(note.updated.getTime());
  expect(out.tags).toEqual(note.tags);
  expect(out.notebook).toBe(note.notebook);
  expect(out.body).toBe(note.body);
}

describe('round-trip', () => {
  it('preserves a plain note', () => {
    expectRoundTrip(base);
  });

  // The specific case that motivated using `yaml` over `js-yaml`.
  it('preserves a title containing a colon', () => {
    expectRoundTrip({ ...base, title: 'Q3: planning and budget' });
  });

  it('preserves titles with YAML-significant characters', () => {
    for (const title of [
      'Title with "double quotes"',
      "Title with 'single quotes'",
      'Title with #hash',
      'Title with - leading dash',
      'Title: with - every {special} [char] & more!',
      '- starts with a dash',
      '  leading and trailing spaces  ',
      'true',
      'null',
      '12345',
      '2024-01-15',
      'a'.repeat(300),
    ]) {
      expectRoundTrip({ ...base, title });
    }
  });

  it('preserves unicode and emoji titles', () => {
    expectRoundTrip({ ...base, title: '日本語のタイトル 🎉 café' });
  });

  it('preserves an empty title', () => {
    expectRoundTrip({ ...base, title: '' });
  });

  it('preserves an empty body', () => {
    expectRoundTrip({ ...base, body: '' });
  });

  it('preserves empty tags', () => {
    expectRoundTrip({ ...base, tags: [] });
  });

  it('preserves tags with spaces and special characters', () => {
    expectRoundTrip({ ...base, tags: ['two words', 'with: colon', 'café', '#hash'] });
  });

  // A note whose body contains a `---` fence must not confuse the parser.
  it('preserves a body containing horizontal rules', () => {
    expectRoundTrip({ ...base, body: 'Above\n\n---\n\nBelow\n' });
  });

  it('preserves a body that itself looks like frontmatter', () => {
    expectRoundTrip({ ...base, body: '---\nid: not-real\n---\n\nBody text\n' });
  });

  it('preserves markdown structures', () => {
    expectRoundTrip({
      ...base,
      body: [
        '# Heading',
        '',
        '- [ ] unchecked',
        '- [x] checked',
        '',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '```js',
        'const x = "---";',
        '```',
        '',
        '![img](files/diagram.png)',
        '',
      ].join('\n'),
    });
  });

  it('preserves trailing whitespace in the body', () => {
    expectRoundTrip({ ...base, body: 'text\n\n\n' });
  });

  it('preserves second-precision timestamps', () => {
    expectRoundTrip({
      ...base,
      created: new Date('1970-01-01T00:00:01Z'),
      updated: new Date('2038-01-19T03:14:07Z'),
    });
  });
});

describe('notebook', () => {
  it('round-trips a notebook name', () => {
    const withNotebook = { ...base, notebook: 'Coupons' };
    const out = parse(serialize(withNotebook));
    expect(out.notebook).toBe('Coupons');
  });

  it('omits the field entirely when there is no notebook', () => {
    const out = serialize(base);
    expect(out).not.toContain('notebook:');
    expect(parse(out).notebook).toBeUndefined();
  });
});

describe('source url', () => {
  it('round-trips a source url', () => {
    const withSource = { ...base, source: 'https://example.com/article?a=1&b=2' };
    const out = parse(serialize(withSource));
    expect(out.source).toBe('https://example.com/article?a=1&b=2');
  });

  it('omits the field entirely when there is no source', () => {
    const out = serialize(base);
    expect(out).not.toContain('source:');
    expect(parse(out).source).toBeUndefined();
  });

  it('handles a url containing yaml-significant characters', () => {
    const withSource = { ...base, source: 'https://x.test/a:b#c' };
    expect(parse(serialize(withSource)).source).toBe('https://x.test/a:b#c');
  });
});

describe('serialize', () => {
  it('emits timestamps without milliseconds', () => {
    const out = serialize(base);
    expect(out).toContain('created: 2024-01-15T09:30:00Z');
    expect(out).not.toContain('.000Z');
  });

  it('opens with a fence and separates the body with one blank line', () => {
    expect(serialize(base)).toMatch(/^---\n[\s\S]*\n---\n\nSome \*\*markdown\*\*/);
  });

  it('rejects a note with no id', () => {
    expect(() => serialize({ ...base, id: '' })).toThrow(FrontmatterError);
  });

  it('rejects an invalid date', () => {
    expect(() => serialize({ ...base, created: new Date('nope') })).toThrow(FrontmatterError);
  });
});

describe('parse', () => {
  it('rejects a document with no frontmatter', () => {
    expect(() => parse('# Just markdown\n')).toThrow(FrontmatterError);
  });

  it('rejects frontmatter missing an id', () => {
    expect(() => parse('---\ntitle: x\ncreated: 2024-01-15T09:30:00Z\nupdated: 2024-01-15T09:30:00Z\n---\n\nbody')).toThrow(
      /Missing required field: id/,
    );
  });

  it('rejects frontmatter missing timestamps', () => {
    expect(() => parse('---\nid: abc\ntitle: x\n---\n\nbody')).toThrow(/created/);
  });

  it('rejects malformed YAML', () => {
    expect(() => parse('---\nid: "unterminated\n---\n\nbody')).toThrow(FrontmatterError);
  });

  it('accepts a hand-written file with quoted timestamps', () => {
    const note = parse(
      '---\nid: abc\ntitle: Hand written\ncreated: "2024-01-15T09:30:00Z"\nupdated: "2024-01-15T09:30:00Z"\ntags: [a, b]\n---\n\nbody\n',
    );
    expect(note.title).toBe('Hand written');
    expect(note.tags).toEqual(['a', 'b']);
    expect(note.created.toISOString()).toBe('2024-01-15T09:30:00.000Z');
  });

  it('accepts a single string tag', () => {
    expect(
      parse('---\nid: abc\ncreated: 2024-01-15T09:30:00Z\nupdated: 2024-01-15T09:30:00Z\ntags: solo\n---\n\nb').tags,
    ).toEqual(['solo']);
  });

  it('defaults missing title and tags', () => {
    const note = parse('---\nid: abc\ncreated: 2024-01-15T09:30:00Z\nupdated: 2024-01-15T09:30:00Z\n---\n\nbody');
    expect(note.title).toBe('');
    expect(note.tags).toEqual([]);
  });

  it('tolerates CRLF line endings', () => {
    const note = parse('---\r\nid: abc\r\ncreated: 2024-01-15T09:30:00Z\r\nupdated: 2024-01-15T09:30:00Z\r\n---\r\n\r\nbody\r\n');
    expect(note.id).toBe('abc');
  });

  it('handles a document with frontmatter but no body', () => {
    expect(parse('---\nid: abc\ncreated: 2024-01-15T09:30:00Z\nupdated: 2024-01-15T09:30:00Z\n---\n').body).toBe('');
  });
});

describe('hasFrontmatter', () => {
  it('distinguishes documents with and without frontmatter', () => {
    expect(hasFrontmatter(serialize(base))).toBe(true);
    expect(hasFrontmatter('# plain\n')).toBe(false);
    expect(hasFrontmatter('text\n---\nnot frontmatter\n---\n')).toBe(false);
  });
});

describe('fields', () => {
  const fields = { Merchant: 'Acme', Amount: 12.5, Paid: true, Expires: '2024-03-01' };

  it('round-trips every value kind with its type intact', () => {
    const out = parse(serialize({ ...base, fields }));
    expect(out.fields).toEqual(fields);
  });

  it('writes fields as ordinary top-level keys, after the note\'s own', () => {
    const out = serialize({ ...base, fields });
    const keys = out
      .split('---')[1]!
      .split('\n')
      .filter((l) => /^\S/.test(l))
      .map((l) => l.split(':')[0]);
    expect(keys).toEqual(['id', 'title', 'created', 'updated', 'tags', 'Merchant', 'Amount', 'Paid', 'Expires']);
    expect(out).toContain('Amount: 12.5\n');
    expect(out).toContain('Paid: true\n');
    expect(out).toContain('Expires: 2024-03-01\n');
  });

  it('keeps text that looks like a number or a boolean as text', () => {
    const out = parse(serialize({ ...base, fields: { Code: '42', Flag: 'true' } }));
    expect(out.fields).toEqual({ Code: '42', Flag: 'true' });
  });

  it('omits the fields entirely when there are none', () => {
    expect(parse(serialize(base)).fields).toBeUndefined();
    expect(parse(serialize({ ...base, fields: {} })).fields).toBeUndefined();
  });

  it('never lets a field overwrite a reserved key, in either direction', () => {
    const out = serialize({ ...base, fields: { title: 'Not the title', Merchant: 'Acme' } });
    expect(out).toContain('title: Meeting notes\n');
    expect(out).not.toContain('Not the title');

    const handWritten = `---\nid: abc\nTitle: Shadow\ncreated: 2024-01-15T09:30:00Z\nupdated: 2024-01-15T09:30:00Z\nMerchant: Acme\n---\n\nbody\n`;
    expect(parse(handWritten).fields).toEqual({ Merchant: 'Acme' });
    expect(parse(handWritten).title).toBe('');
  });

  it('leaves lists and maps behind and reads a yaml timestamp as a date', () => {
    const handWritten = `---\nid: abc\ncreated: 2024-01-15T09:30:00Z\nupdated: 2024-01-15T09:30:00Z\naliases: [a, b]\nmeta: {k: v}\nnothing: null\nExpires: 2024-03-01\n---\n`;
    expect(parse(handWritten).fields).toEqual({ Expires: '2024-03-01' });
  });
});
