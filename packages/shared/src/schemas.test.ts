import { describe, expect, it } from 'vitest';
import { isSingleEmoji, notebookEmojiSchema } from './schemas.js';

describe('isSingleEmoji', () => {
  it.each([
    ['a plain emoji', '🧾'],
    ['one with a variation selector', '❤️'],
    ['a ZWJ sequence', '👩‍💻'],
    ['a skin tone', '👍🏽'],
    ['a country flag', '🇯🇵'],
    ['a subdivision flag', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'],
    ['a keycap', '1️⃣'],
  ])('accepts %s', (_, value) => {
    expect(isSingleEmoji(value)).toBe(true);
  });

  it.each([
    ['two emoji', '🧾📚'],
    ['a letter', 'a'],
    ['a word', 'Tax'],
    ['a bare digit', '7'],
    ['a bare hash', '#'],
    ['an emoji and a letter', '🧾a'],
    ['nothing', ''],
  ])('refuses %s', (_, value) => {
    expect(isSingleEmoji(value)).toBe(false);
  });
});

describe('notebookEmojiSchema', () => {
  it('trims, and clears a blank to null', () => {
    expect(notebookEmojiSchema.parse(' 🧾 ')).toBe('🧾');
    expect(notebookEmojiSchema.parse('')).toBeNull();
    expect(notebookEmojiSchema.parse(null)).toBeNull();
  });

  it('refuses anything but one emoji', () => {
    expect(notebookEmojiSchema.safeParse('ab').success).toBe(false);
  });
});
