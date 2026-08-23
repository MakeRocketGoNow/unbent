import { describe, expect, it } from 'vitest';
import { parseEnexStream } from './parse.js';

/**
 * Progress reporting during a parse.
 *
 * A real ENEX arrives in very few stream chunks — a 968KB file yields three — and each can
 * hold many notes. Reporting progress only between chunks meant the UI sat at its first
 * value for the entire import, which is indistinguishable from a hang.
 */

/** Builds a stream that delivers the whole document in one chunk, as a real file does. */
function streamOf(text: string, chunkSize = 1_000_000): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function enexOf(titles: string[]): string {
  const notes = titles
    .map(
      (t) => `<note><title>${t}</title>
      <content><![CDATA[<en-note><div>body</div></en-note>]]></content>
      </note>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><en-export>${notes}</en-export>`;
}

describe('progress reporting', () => {
  it('reports after every note, not once per chunk', async () => {
    const doc = enexOf(['One', 'Two', 'Three']);
    const updates: number[] = [];

    await parseEnexStream(streamOf(doc), {
      onNote: () => undefined,
      onProgress: (bytes) => updates.push(bytes),
    });

    // Three notes in a single chunk must still produce per-note updates. Before the fix
    // this saw one update for the whole file.
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the UI moving while notes are slow to process', async () => {
    const doc = enexOf(['One', 'Two', 'Three', 'Four']);
    const order: string[] = [];

    await parseEnexStream(streamOf(doc), {
      onNote: async (note) => {
        order.push(`note:${note.title}`);
        await Promise.resolve();
      },
      onProgress: () => order.push('progress'),
    });

    // A progress event must land between notes, not all of them at the end — that is what
    // makes a slow import look alive.
    const firstNote = order.indexOf('note:One');
    const secondNote = order.indexOf('note:Two');
    const between = order.slice(firstNote, secondNote);
    expect(between).toContain('progress');
  });

  it('counts bytes rather than decoded characters', async () => {
    // Multi-byte characters make the two disagree: 'é' is one char but two UTF-8 bytes.
    const doc = enexOf(['Café ☕ Résumé']);
    const bytes = new TextEncoder().encode(doc).length;

    let last = 0;
    await parseEnexStream(streamOf(doc), {
      onNote: () => undefined,
      onProgress: (n) => {
        last = n;
      },
    });

    // Counting `value.length` after TextDecoderStream would report fewer than the real
    // byte total, so a progress bar measured against File.size would never fill.
    expect(last).toBe(bytes);
    expect(bytes).toBeGreaterThan(doc.length);
  });

  it('reports the full size by the end', async () => {
    const doc = enexOf(['One', 'Two']);
    const bytes = new TextEncoder().encode(doc).length;

    let last = 0;
    await parseEnexStream(streamOf(doc, 64), {
      onNote: () => undefined,
      onProgress: (n) => {
        last = n;
      },
    });

    expect(last).toBe(bytes);
  });
});
