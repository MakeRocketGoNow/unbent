/**
 * Volume: a few hundred ordinary notes, generated.
 *
 * The hand-written notes are enough to look at and too few to page, rank or select in
 * bulk. These fill that gap — enough that the list needs its second and third page, a
 * search for a common word returns more than fits, and Select all means something.
 *
 * Deterministic: a fixed-seed generator, so every run produces the same notes with the
 * same keys, and a re-run finds them rather than adding more. Change `COUNT` or the word
 * lists and the notes change with them; `--reset` clears the old ones.
 *
 * Older than everything hand-written, so the list newest first opens on the showcase and
 * the notebooks' own records, and these sit behind them like the years of notes behind a
 * real account's recent ones. Most are unfiled, which is where a real archive's bulk
 * lives, and the rest are spread over the showcase's notebooks without fields.
 */

const COUNT = 300;

/** mulberry32: small, fast, and the same sequence from the same seed on every platform. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  'garden', 'budget', 'kitchen', 'bike', 'camping', 'taxes', 'insurance', 'car', 'garage', 'birthday',
  'podcast', 'running', 'reading', 'woodworking', 'photography', 'holiday', 'move', 'school', 'yard', 'printer',
];
const KINDS = [
  (t) => `Notes on the ${t}`,
  (t) => `${cap(t)} checklist`,
  (t) => `Ideas for the ${t}`,
  (t) => `${cap(t)}: what to try next`,
  (t) => `Questions about the ${t}`,
  (t) => `${cap(t)} plan`,
  (t) => `Links about ${t}`,
];
const SENTENCES = [
  'Worth checking again before the end of the month.',
  'The cheaper option looked fine on paper and was not.',
  'Ask around before buying anything new.',
  'Measured twice, and the second measurement was the right one.',
  'Most of this can wait until spring.',
  'Write down what worked, because next year I will not remember.',
  'The instructions skipped a step, noted below.',
  'Two options, neither obviously better.',
  'Keep the receipt with the warranty card.',
  'Done for now; revisit if it breaks again.',
  'A quick win compared with everything else on the list.',
  'Took longer than expected, mostly waiting on parts.',
];
const ITEMS = [
  'compare prices', 'call for a quote', 'order the part', 'check the manual', 'clear a weekend',
  'ask a neighbour', 'return the old one', 'take photos first', 'label everything', 'book a time',
];
const TAGS = [
  'todo', 'someday', 'reference', 'waiting', 'idea', 'errand', 'weekend', 'research', 'money', 'repair',
  'family', 'outdoors', 'learning', 'follow-up', 'archive',
];
const NOTEBOOKS = ['Projects', 'Home', 'Reading', 'Travel'];

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function bulkNotes() {
  const random = rng(20261001);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const notes = [];
  for (let i = 0; i < COUNT; i++) {
    const topic = pick(TOPICS);
    const title = pick(KINDS)(topic);
    const paragraphs = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
      Array.from({ length: 2 + Math.floor(random() * 3) }, () => pick(SENTENCES)).join(' '),
    );
    const checklist =
      random() < 0.4
        ? '\n\n' + Array.from({ length: 2 + Math.floor(random() * 4) }, () => `- [${random() < 0.5 ? 'x' : ' '}] ${pick(ITEMS)}`).join('\n')
        : '';
    const tags = [...new Set(Array.from({ length: Math.floor(random() * 4) }, () => pick(TAGS)))];
    notes.push({
      key: `bulk/${i}`,
      // Numbered, so two notes that drew the same title are still told apart in a list.
      title: `${title} (${i + 1})`,
      body: `${cap(topic)}. ${paragraphs.join('\n\n')}${checklist}`,
      tags,
      ...(random() < 0.6 ? {} : { notebook: pick(NOTEBOOKS) }),
      // Spread across the two years before the hand-written notes begin.
      age: 300 + Math.floor(random() * 730),
    });
  }
  return notes;
}
