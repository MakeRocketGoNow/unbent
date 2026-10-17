import { describe, expect, it } from 'vitest';
import { TAG_COLOR_COUNT, assignOptionColors, colorName, leastUsedColor, parseColorName } from './colors.js';

describe('leastUsedColor', () => {
  it('walks the whole palette before any colour repeats, lowest index first among ties', () => {
    const used: number[] = [];
    for (let i = 0; i < TAG_COLOR_COUNT; i++) {
      const next = leastUsedColor(used);
      expect(next).toBe(i);
      used.push(next);
    }
    // The eleventh is the first repeat, and it is the lowest index again.
    expect(leastUsedColor(used)).toBe(0);
  });

  it('fills the gap a recolour or a deletion left', () => {
    expect(leastUsedColor([0, 1, 3, 4, 5, 6, 7, 8, 9])).toBe(2);
    expect(leastUsedColor([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(1);
  });

  it('does not count a sibling with no colour yet, or one off the palette', () => {
    expect(leastUsedColor([null, undefined, 0, 42, -1])).toBe(1);
    expect(leastUsedColor([])).toBe(0);
  });
});

describe('assignOptionColors', () => {
  it('keeps a standing option, drops a gone one, and gives a new one the least-used colour', () => {
    const prior = { Bike: 3, Toys: 5, Old: 0 };
    expect(assignOptionColors(['Bike', 'Toys', 'Games'], prior)).toEqual({ Bike: 3, Toys: 5, Games: 0 });
  });

  it('assigns a whole new list through the palette in order', () => {
    expect(assignOptionColors(['a', 'b', 'c'], null)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('takes a wanted colour over the kept one, and only for options the list holds', () => {
    expect(assignOptionColors(['a', 'b'], { a: 0, b: 1 }, { a: 7, zzz: 2 })).toEqual({ a: 7, b: 1 });
  });

  it('ignores a kept or wanted colour that is off the palette', () => {
    expect(assignOptionColors(['a', 'b'], { a: 99 }, { b: -1 })).toEqual({ a: 0, b: 1 });
  });

  it('writes the colours in list order', () => {
    expect(Object.keys(assignOptionColors(['z', 'a'], { a: 1, z: 0 }))).toEqual(['z', 'a']);
  });
});

describe('colour names', () => {
  it('round-trips every index by name and accepts the index itself', () => {
    for (let i = 0; i < TAG_COLOR_COUNT; i++) {
      expect(parseColorName(colorName(i))).toBe(i);
      expect(parseColorName(i)).toBe(i);
    }
    expect(parseColorName(' Green ')).toBe(3);
    expect(parseColorName('mauve')).toBeUndefined();
    expect(parseColorName(10)).toBeUndefined();
  });
});
