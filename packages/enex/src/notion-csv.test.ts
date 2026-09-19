import { describe, expect, it } from 'vitest';
import { parseCsv } from './notion-csv.js';

describe('parseCsv', () => {
  it('reads what Notion writes: a BOM, quoted cells, doubled quotes, and CRLF', () => {
    const text = '﻿Name,Rating,Notes\r\nEspresso,"★★","Short, sharp. Said ""wow""."\r\nLatte,,\r\n';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Rating', 'Notes'],
      ['Espresso', '★★', 'Short, sharp. Said "wow".'],
      ['Latte', '', ''],
    ]);
  });

  it('keeps a newline inside quotes as part of the cell, not a row break', () => {
    const text = 'Name,Notes\nRide,"First line.\nSecond line.\n\nThird after a blank."\nNext,plain';
    expect(parseCsv(text)).toEqual([
      ['Name', 'Notes'],
      ['Ride', 'First line.\nSecond line.\n\nThird after a blank.'],
      ['Next', 'plain'],
    ]);
  });

  it('reads a file without a trailing newline, and drops blank lines', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });
});
