/**
 * Cleaning and quality-filtering for text extracted from scanned attachments.
 *
 * Evernote OCR'd the PDFs in a real export and embedded the text layer, so the content is
 * already there, but roughly a fifth of it is unusable character noise, and much of the
 * rest is letter-spaced ("H a r b o r v i e w"), which no tokenizer will match against a normal
 * query. Both are handled here rather than at the index, so the stored text is the text a
 * search will actually see.
 */

/**
 * Rejoins characters that OCR split with spaces.
 *
 * A run of three or more single characters separated by spaces is a spacing artifact, not
 * language: the pattern appears throughout real scans as `H a r b o r v i e w` or
 * `S t a t e m e n t  D a t e`. Left alone, "Harborview" is unfindable.
 *
 * Requires three or more so genuine short sequences ("a b c" in a list, "I a m") survive.
 */
export function rejoinLetterSpacing(text: string): string {
  return text.replace(/(?:(?<=^|\s)\S(?: \S){2,})(?=$|\s)/gm, (run) => {
    const chars = run.split(' ');
    // Only collapse when the run is mostly letters and digits; a row of punctuation or
    // table rules is not a spaced-out word.
    const alnum = chars.filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
    return alnum / chars.length >= 0.8 ? chars.join('') : run;
  });
}

/** Collapses the whitespace that page-based extraction leaves behind. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface TextQuality {
  usable: boolean;
  reason?: string;
  /** Fraction of tokens that look like real words. */
  wordRatio: number;
  wordCount: number;
}

/** Tokens of two or more letters, which is what a search query will actually match. */
const WORDISH = /[\p{L}]{2,}/gu;

/**
 * Judges whether extracted text is language or noise.
 *
 * Tuned against real samples: failed scans yield things like
 * `> CO 5 I > — O — - f O 1" 2 o in in I s I`: 53 characters of isolated symbols with
 * almost no multi-letter words. Successful ones run to thousands of characters of
 * recognizable prose. The gap between those is wide, so the thresholds are deliberately
 * loose; the goal is to drop obvious junk, not to grade legibility.
 */
export function assessText(text: string): TextQuality {
  const trimmed = text.trim();
  if (trimmed.length < 40) {
    return { usable: false, reason: 'too short', wordRatio: 0, wordCount: 0 };
  }

  const words = trimmed.match(WORDISH) ?? [];
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  const wordRatio = tokens.length > 0 ? words.length / tokens.length : 0;

  if (words.length < 12) {
    return { usable: false, reason: 'too few words', wordRatio, wordCount: words.length };
  }
  if (wordRatio < 0.3) {
    return { usable: false, reason: 'mostly symbols', wordRatio, wordCount: words.length };
  }

  return { usable: true, wordRatio, wordCount: words.length };
}

/** D1 caps a row at 2MB; a long scanned document can exceed that on its own. */
export const MAX_ATTACHMENT_TEXT = 500_000;

export interface CleanedText {
  text: string;
  quality: TextQuality;
}

/**
 * Full pipeline: rejoin spacing, normalize whitespace, judge quality, cap length.
 *
 * Returns the cleaned text regardless so a caller can log what was rejected; `quality.usable`
 * is what decides whether it belongs in the index.
 */
export function cleanExtractedText(raw: string): CleanedText {
  const cleaned = normalizeWhitespace(rejoinLetterSpacing(raw)).slice(0, MAX_ATTACHMENT_TEXT);
  return { text: cleaned, quality: assessText(cleaned) };
}

/**
 * Content types worth attempting extraction on.
 *
 * Here rather than beside pdf.js because the API asks the same question before handing a
 * file to Workers AI, and this module is the one it can import without dragging a PDF
 * library into a Worker bundle.
 */
export function isExtractable(mime: string): boolean {
  return mime === 'application/pdf';
}
