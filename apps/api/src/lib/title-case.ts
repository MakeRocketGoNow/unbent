/**
 * Title case for the titles auto-fill suggests: "Acme Hardware invoice, march 2026"
 * becomes "Acme Hardware Invoice, March 2026", and "ACME HARDWARE" becomes "Acme Hardware".
 *
 * A suggested title comes from one of three places: the language model's, the reader's
 * name for a lone picture, or a line Jev picked off the document. The model can be asked
 * for title case, but a prompt gets it most of the time, not every time, and the other two
 * come from a scan's own lines, which are in whatever case they were printed in. So the
 * casing is done here, over all three, and the result is the same whichever one won.
 *
 * The style is AP's: every word capitalized except articles, coordinating conjunctions and
 * prepositions of three letters or fewer, and the first and last word always. Chicago
 * lowercases every preposition, which gives "Receipt from Acme" but also "Notes about
 * the Roof", and a filing label reads better with the long words standing up.
 *
 * What it must not do is flatten a word someone cased on purpose. A word with a capital
 * past its first letter — "IRS", "iPhone", "McDonald's", "eBay" — is left as it is, and so
 * is anything with a digit ("W-2", "Q3", "2026") or that reads as an address or a URL.
 *
 * The one place it has to guess is a title in capitals throughout, which is how a letterhead
 * or a receipt's header is printed and so how Jev's pick often arrives. There every word
 * is taken to be a shouted word rather than an acronym, because the alternative leaves
 * "ACME HARDWARE" as the title — except a word with no vowel ("LLC", "PDF", "TV"), which
 * cannot be a spoken word. "IRS" in a title that is otherwise capitals comes out "Irs";
 * that is the trade, and a single capital word alone is left alone for the same reason.
 */

/** Lowercased mid-title: articles, coordinating conjunctions, prepositions of ≤3 letters. */
const MINOR = new Set([
  'a', 'an', 'the',
  'and', 'but', 'or', 'nor', 'for', 'so', 'yet',
  'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'vs', 'v',
]);

/** Punctuation after which the next word starts a phrase and is capitalized regardless. */
const PHRASE_END = /[:–—]$/;

const hasLetter = /\p{L}/u;
const hasLower = /\p{Ll}/u;

/** Something typed as it is spelled: an address, a URL, a domain, a filename. */
function isLiteral(word: string): boolean {
  return /:\/\/|@|\p{L}\.\p{L}/u.test(word);
}

/** A capital anywhere past the first letter: "IRS", "iPhone", "McDonald's". */
function isCasedOnPurpose(segment: string): boolean {
  return /\p{Lu}/u.test(segment.replace(/[^\p{L}]/gu, '').slice(1));
}

function capitalize(segment: string): string {
  return segment.replace(/\p{L}/u, (c) => c.toUpperCase());
}

export function titleCase(title: string): string {
  const tokens = title.split(/(\s+)/);
  const words = tokens.filter((t) => t && !/^\s+$/.test(t));
  const letterWords = words.filter((w) => hasLetter.test(w));
  const shouted = letterWords.length > 1 && !hasLower.test(title);

  let index = -1;
  let startsPhrase = true;
  return tokens
    .map((token) => {
      if (!token || /^\s+$/.test(token)) return token;
      index += 1;
      const first = startsPhrase;
      const last = index === words.length - 1;
      startsPhrase = PHRASE_END.test(token) || /^[-–—]$/.test(token);
      if (isLiteral(token)) return token;

      const segments = token.split(/([-/])/);
      return segments
        .map((segment, i) => {
          if (i % 2 === 1 || !hasLetter.test(segment) || /\d/.test(segment)) return segment;
          let s = segment;
          if (shouted) {
            if (!/[aeiouy]/i.test(s.replace(/[^\p{L}]/gu, ''))) return s;
            s = s.toLowerCase();
          } else if (isCasedOnPurpose(s)) {
            return s;
          }
          const core = s.toLowerCase().replace(/[^\p{L}'’]/gu, '');
          // A compound's own ends stand up ("Follow-Up"); only its middle joins it ("Up-to-Date").
          const end = i === 0 || i === segments.length - 1;
          const pinned = segments.length > 1 ? end : first || last;
          if (MINOR.has(core) && !pinned) return s.toLowerCase();
          return capitalize(s);
        })
        .join('');
    })
    .join('');
}
