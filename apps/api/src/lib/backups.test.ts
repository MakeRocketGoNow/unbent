import { describe, expect, it } from 'vitest';
import { dropBytes, takeBytes } from './backups.js';

/**
 * Cutting the dump's stream into upload parts (`upload` in backups.ts): every part but
 * the last exactly `partBytes`, whatever the sizes of the slices it is cut from. The
 * store tests run it on parts of five megabytes; these are the edges, at sizes that
 * make them easy to see: a chunk that straddles a cut, one that ends on it, and one
 * bigger than a whole part.
 */
const bytes = (...values: number[]) => new Uint8Array(values);

/** What `upload` does: whole parts while there are enough bytes, then the rest. */
function cut(chunks: Uint8Array[], partBytes: number): number[][] {
  const parts: number[][] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for (const chunk of chunks) {
    pending.push(chunk);
    pendingBytes += chunk.byteLength;
    while (pendingBytes >= partBytes) {
      parts.push([...takeBytes(pending, partBytes)]);
      pending = dropBytes(pending, partBytes);
      pendingBytes -= partBytes;
    }
  }
  parts.push([...takeBytes(pending, pendingBytes)]);
  return parts;
}

describe('cutting a stream into parts', () => {
  it('takes and drops across chunk boundaries', () => {
    const chunks = [bytes(1, 2), bytes(3, 4, 5), bytes(6)];
    expect([...takeBytes(chunks, 3)]).toEqual([1, 2, 3]);
    expect(dropBytes(chunks, 3).map((c) => [...c])).toEqual([[4, 5], [6]]);
    expect(dropBytes(chunks, 2).map((c) => [...c])).toEqual([[3, 4, 5], [6]]);
    expect(dropBytes(chunks, 6)).toEqual([]);
    expect([...takeBytes(chunks, 0)]).toEqual([]);
  });

  it('makes every part but the last the same size, and loses and repeats nothing', () => {
    const chunks = [bytes(1, 2), bytes(3, 4, 5, 6, 7, 8, 9), bytes(10, 11, 12), bytes(13)];
    const parts = cut(chunks, 3);
    expect(parts).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13]]);
    // Ending exactly on a cut leaves an empty last part, which `upload` does not send.
    expect(cut([bytes(1, 2, 3), bytes(4, 5, 6)], 3)).toEqual([[1, 2, 3], [4, 5, 6], []]);
  });
});
