import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assessText,
  cleanExtractedText,
  normalizeWhitespace,
  rejoinLetterSpacing,
} from './ocr-text.js';

describe('rejoinLetterSpacing', () => {
  it('rejoins a spaced-out word', () => {
    expect(rejoinLetterSpacing('H a r b o r v i e w')).toBe('Harborview');
  });

  it('rejoins several spaced words in a line', () => {
    expect(rejoinLetterSpacing('S t a t e m e n t D a t e')).toBe('StatementDate');
  });

  it('leaves normal prose alone', () => {
    const prose = 'Patient services provided at the clinic on Tuesday';
    expect(rejoinLetterSpacing(prose)).toBe(prose);
  });

  it('leaves short runs alone so real words survive', () => {
    // Two single characters is not evidence of spacing damage.
    expect(rejoinLetterSpacing('I am a person')).toBe('I am a person');
  });

  it('does not collapse runs of punctuation', () => {
    const rule = '- - - - - -';
    expect(rejoinLetterSpacing(rule)).toBe(rule);
  });

  it('handles mixed spaced and normal text', () => {
    expect(rejoinLetterSpacing('Sent to H a r b o r v i e w today')).toBe('Sent to Harborview today');
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs of spaces and blank lines', () => {
    expect(normalizeWhitespace('a    b\n\n\n\nc')).toBe('a b\n\nc');
  });

  it('normalizes non-breaking spaces', () => {
    expect(normalizeWhitespace('a b')).toBe('a b');
  });
});

/**
 * The thresholds were tuned against real scans from an Evernote export, and these samples
 * reproduce their shape: the letter spacing, the spaced-out digits, the symbol soup of a
 * failed scan. The originals were personal documents and have been withdrawn from the
 * repository and its history; `scripts/make-scan-fixtures.mjs` builds these in their
 * place, with invented names and numbers, so the assertions below are unchanged.
 */
describe('assessText on OCR-shaped output', () => {
  const samples = JSON.parse(
    readFileSync(new URL('../test/fixtures/ocr-samples.json', import.meta.url), 'utf8'),
  ) as Array<{ len: number; sample: string }>;

  it('rejects the failed scan', () => {
    // 53 characters of isolated symbols: '> CO 5 I > — O — - f O 1" 2 o in in I s I'
    const junk = samples.find((s) => s.len < 100)!;
    const { quality } = cleanExtractedText(junk.sample);
    expect(quality.usable).toBe(false);
  });

  it('accepts the readable scans', () => {
    for (const sample of samples.filter((s) => s.len > 1000)) {
      const { quality } = cleanExtractedText(sample.sample);
      expect(quality.usable).toBe(true);
    }
  });

  it('makes a letter-spaced name searchable', () => {
    const spaced = samples.find((s) => s.sample.includes('H a r b o r v i e w'))!;
    const { text } = cleanExtractedText(spaced.sample);
    // 'Harborview' is what a user would actually type.
    expect(text).toContain('Harborview');
  });

  it('preserves the content worth searching for', () => {
    const pharmacy = samples.find((s) => s.sample.includes('Northfield'))!;
    const { text, quality } = cleanExtractedText(pharmacy.sample);
    expect(quality.usable).toBe(true);
    expect(text).toContain('Northfield');
    expect(text).toContain('Springfield');
  });
});

describe('assessText thresholds', () => {
  it('rejects empty and very short text', () => {
    expect(assessText('').usable).toBe(false);
    expect(assessText('short').usable).toBe(false);
  });

  it('rejects symbol soup', () => {
    expect(assessText('> < — • § ¤ ‡ † ± ÷ × ¶ © ® ™ ° µ ¢ £ ¥ € ½ ¼ ¾').usable).toBe(false);
  });

  it('accepts ordinary prose', () => {
    const prose =
      'The garden was inspected this morning for evidence of frost damage sustained ' +
      'during the cold snap. Three raised beds were covered and a second layer of mulch ' +
      'was added before the next forecast freeze.';
    expect(assessText(prose).usable).toBe(true);
  });

  it('accepts text that is mostly numbers but has real words', () => {
    const statement =
      'Statement Date 03/14/2019 Patient Services Provided 30919277 Amount Due 96.20 ' +
      'Clinic Services Description Office Visit Laboratory Radiology Total Balance';
    expect(assessText(statement).usable).toBe(true);
  });

  it('caps very long documents', () => {
    const huge = 'word '.repeat(200_000);
    expect(cleanExtractedText(huge).text.length).toBeLessThanOrEqual(500_000);
  });
});
