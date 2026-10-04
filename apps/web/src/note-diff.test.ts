import { describe, it, expect } from 'vitest';
import { diffNote, MAX_EDIT_LINES, type DiffRow } from './note-diff.js';

/**
 * What restoring a version would change (MAK-167). From the note now to the version:
 * "added" is what Restore brings back, "removed" what it takes out.
 */
const note = (body: string, title = 'Acme order') => ({ title, body });
const lines = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join('\n');

/** A row as text, with removed words in [-…-] and added ones in {+…+}, to read at a glance. */
function show(row: DiffRow): string {
  if (row.kind === 'same') return `  ${row.text}`;
  if (row.kind === 'fold') return `… ${row.lines.length}`;
  const text = row.parts
    .map((p) => (p.kind === 'same' ? p.text : p.kind === 'added' ? `{+${p.text}+}` : `[-${p.text}-]`))
    .join('');
  return `${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : '~'} ${text}`;
}

function rows(current: string, version: string): string[] {
  const { body } = diffNote(note(current), note(version));
  if (typeof body === 'string') throw new Error(`expected rows, got ${body}`);
  return body.map(show);
}

describe('diffNote', () => {
  it('marks only the two numbers that differ in a table, and folds the rest', () => {
    const table = (a: number, b: number) =>
      [
        '# Acme order',
        '',
        'Shipped from example.com.',
        '',
        '| Item | Qty |',
        '| --- | --- |',
        '| Bolts | 12 |',
        `| Nuts | ${a} |`,
        '| Washers | 30 |',
        `| Springs | ${b} |`,
        '| Pins | 8 |',
        '',
        'Thanks.',
      ].join('\n');
    expect(rows(table(40, 5), table(45, 7))).toEqual([
      '… 5',
      '  | --- | --- |',
      '  | Bolts | 12 |',
      '~ | Nuts | [-40-]{+45+} |',
      '  | Washers | 30 |',
      '~ | Springs | [-5-]{+7+} |',
      '  | Pins | 8 |',
      '  ',
      '  Thanks.',
    ]);
  });

  it('says a version identical to the note is the same', () => {
    expect(diffNote(note('One\nTwo'), note('One\nTwo'))).toEqual({ titleChanged: false, body: 'same' });
    expect(diffNote(note(''), note(''))).toEqual({ titleChanged: false, body: 'same' });
  });

  it('notices a title that differs when the text does not', () => {
    expect(diffNote(note('Text', 'Acme'), note('Text', 'Acme (final)'))).toEqual({ titleChanged: true, body: 'same' });
  });

  it('shows the long version of a gutted note as all added, without stalling', () => {
    const long = lines(5000, (i) => `| Acme row ${i} | ${i * 3} | example.com/${i} |`);
    const started = performance.now();
    const result = diffNote(note('gone'), note(long)).body;
    expect(performance.now() - started).toBeLessThan(500);
    if (typeof result === 'string') throw new Error(result);
    expect(result).toHaveLength(5001);
    expect(result.filter((r) => r.kind === 'added')).toHaveLength(5000);
    expect(result.filter((r) => r.kind === 'removed')).toHaveLength(1);
  });

  it('shows an empty note against a version as all added, and the reverse as all removed', () => {
    expect(rows('', 'One\nTwo')).toEqual(['+ {+One+}', '+ {+Two+}']);
    expect(rows('One\nTwo', '')).toEqual(['- [-One-]', '- [-Two-]']);
  });

  it('gives up on two long bodies with nothing in common, quickly', () => {
    const a = lines(5000, (i) => `| Acme row ${i} | ${i * 3} |`);
    const b = lines(5000, (i) => `A different line ${i}, from example.com`);
    const started = performance.now();
    expect(diffNote(note(a), note(b)).body).toBe('too-different');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('compares up to the edit cap, and not past it', () => {
    const base = lines(2000, (i) => `Line ${i}`);
    // Each changed line is one removed and one added.
    const changed = (n: number) => lines(2000, (i) => (i < n ? `Changed ${i}` : `Line ${i}`));
    expect(Array.isArray(diffNote(note(base), note(changed(MAX_EDIT_LINES / 2))).body)).toBe(true);
    expect(diffNote(note(base), note(changed(MAX_EDIT_LINES / 2 + 1))).body).toBe('too-different');
  });

  it('draws lines with little in common as whole lines out and in, not as confetti', () => {
    expect(rows('Keep\nThe quick brown fox', 'Keep\nA slow green turtle')).toEqual([
      '  Keep',
      '- [-The quick brown fox-]',
      '+ {+A slow green turtle+}',
    ]);
  });

  it('keeps two lines beside a change and folds a stretch of four or more', () => {
    const body = (mid: string) => lines(13, (i) => (i === 6 ? mid : `Line ${i}`));
    expect(rows(body('Acme 1'), body('Acme 2'))).toEqual([
      '… 4',
      '  Line 4',
      '  Line 5',
      '~ Acme [-1-]{+2+}',
      '  Line 7',
      '  Line 8',
      '… 4',
    ]);
  });

  it('shows a stretch under four in full rather than folding it', () => {
    const body = (mid: string) => lines(9, (i) => (i === 5 ? mid : `Line ${i}`));
    // Five before the change: two kept, three left — too few to fold.
    expect(rows(body('Acme 1'), body('Acme 2'))[0]).toBe('  Line 0');
  });

  it('folds between two changes only what is beyond both contexts', () => {
    const body = (a: string, b: string) => lines(10, (i) => (i === 0 ? a : i === 9 ? b : `Line ${i}`));
    expect(rows(body('A 1', 'B 1'), body('A 2', 'B 2'))).toEqual([
      '~ A [-1-]{+2+}',
      '  Line 1',
      '  Line 2',
      '… 4',
      '  Line 7',
      '  Line 8',
      '~ B [-1-]{+2+}',
    ]);
  });

  it('reads CRLF and a trailing newline as no difference', () => {
    expect(diffNote(note('One\r\nTwo\r\n'), note('One\nTwo')).body).toBe('same');
    expect(diffNote(note('One\nTwo'), note('One\nTwo\n')).body).toBe('same');
    expect(rows('One\r\nTwo 1\r\n', 'One\nTwo 2')).toEqual(['  One', '~ Two [-1-]{+2+}']);
  });
});
