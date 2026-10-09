import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { MarkdownConverter } from './extract-text.js';
import {
  autofillReaders,
  readAttachment,
  readPendingFiles,
  serverCanRead,
  uploadReaders,
  type BlobStore,
  type StoredFile,
} from './read-attachment.js';
import { LlmError, type FileReading, type LanguageModel } from './llm.js';
import { PressUsage } from './llm-usage.js';

const prose =
  'Your diagnosis based on what you shared about how you are feeling is allergic rhinitis, ' +
  'also known as hay fever, and the plan is an antihistamine each morning for two weeks.';

/** Throws on an untyped blob, as Workers AI's conversion does. */
function converter(data: string | null): MarkdownConverter {
  return {
    toMarkdown: () => ({
      transform: async ({ blob }) => {
        if (!blob.type) throw new Error('Too small: expected string to have >=1 characters');
        return data === null ? { format: 'error', error: 'unreadable' } : { format: 'markdown', data };
      },
    }),
  };
}

/** What every stand-in reading costs, so a test can see it carried into the write. */
const cost = { model: 'stand-in', inputTokens: 1500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

function vision(reading: FileReading | null): Pick<LanguageModel, 'read'> & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => ({ value: reading, usage: cost })) };
}

const blobs: BlobStore = {
  get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('bytes').buffer as ArrayBuffer }),
};

function repo() {
  return { recordText: vi.fn(async () => {}) };
}

const pdf: StoredFile = { id: 'a1', noteId: 'n1', filename: 'scan.pdf', contentType: 'application/pdf', size: 100, r2Key: 'k' };
const photo: StoredFile = { ...pdf, id: 'a2', filename: 'card.jpg', contentType: 'image/jpeg' };

const said: FileReading = { name: 'A card', kind: 'business card', description: 'A plumber’s card.', text: 'ACME' };

describe('what the server reads after an upload', () => {
  it('reads a PDF only where the conversion is bound, and never a picture', () => {
    expect(serverCanRead({ AI: {} }, 'application/pdf', 10)).toBe(true);
    expect(serverCanRead({}, 'application/pdf', 10)).toBe(false);
    expect(serverCanRead({ AI: {} }, 'image/png', 10)).toBe(false);
    expect(serverCanRead({ AI: {} }, 'text/plain', 10)).toBe(false);
  });

  it('hands an upload the free reader alone, and a press the model as well where there is a key', () => {
    const ai = converter('x');
    expect(uploadReaders({ AI: ai, ANTHROPIC_API_KEY: 'k' } as { AI: MarkdownConverter })).toEqual({ converter: ai });
    expect(Object.keys(autofillReaders({ AI: ai, ANTHROPIC_API_KEY: 'k' })).sort()).toEqual(['converter', 'llm']);
    expect(autofillReaders({ AI: ai })).toEqual({ converter: ai });
    expect(uploadReaders({})).toEqual({});
  });

  /**
   * The rule of MAK-179, held against the source: the model is built for reading in one
   * place, and only the Auto-fill route builds it at all. A new caller of either fails
   * here by name, and has to argue for a model call nobody pressed for.
   */
  it('builds the model in one place, which only the Auto-fill route calls', () => {
    // `.href`: the runtime's URL type and node's disagree on a detail, and the string is enough.
    const src = fileURLToPath(new URL('..', import.meta.url).href);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(src);
    const callers = (needle: string) =>
      files.filter((f) => readFileSync(f, 'utf8').includes(needle)).map((f) => relative(src, f)).sort();
    expect(callers('llmFrom(')).toEqual(['lib/llm.ts', 'lib/read-attachment.ts', 'routes/notes.ts']);
    expect(callers('autofillReaders(')).toEqual(['lib/read-attachment.ts', 'routes/notes.ts']);
  });
});

describe('reading a file', () => {
  it('takes the text layer first and never pays for a scan that has one', async () => {
    const eyes = vision(said);
    const r = repo();
    const outcome = await readAttachment(blobs, { converter: converter(`# scan.pdf\n## Contents\n${prose}`), llm: eyes }, r, pdf);
    expect(outcome).toBe('text');
    expect(eyes.read).not.toHaveBeenCalled();
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a1', text: expect.stringContaining('allergic'), readBy: null }));
  });

  it('hands a scan the layer had nothing for to the model, and records the answer under its name', async () => {
    const eyes = vision(said);
    const r = repo();
    const outcome = await readAttachment(blobs, { converter: converter('# scan.pdf\n## Metadata\n- Creator=ScanSnap\n'), llm: eyes }, r, pdf);
    expect(outcome).toBe('vision');
    expect(eyes.read).toHaveBeenCalledWith(expect.objectContaining({ filename: 'scan.pdf', contentType: 'application/pdf' }));
    expect(r.recordText).toHaveBeenCalledTimes(1);
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('A card'), readBy: 'vision' }), { job: 'read', ...cost });
  });

  it('closes an empty scan as before when there is no model, and leaves an unreadable one pending', async () => {
    const r = repo();
    expect(await readAttachment(blobs, { converter: converter('# x\n## Metadata\n- a=b\n') }, r, pdf)).toBe('empty');
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ text: '', readBy: null }));
    expect(await readAttachment(blobs, { converter: converter(null) }, repo(), pdf)).toBe('unread');
  });

  it('lets a conversion that throws fail the read, and never pays the model for it', async () => {
    const throwing: MarkdownConverter = {
      toMarkdown: () => ({
        transform: async () => {
          throw new Error('binding fault');
        },
      }),
    };
    const eyes = vision(said);
    const r = repo();
    await expect(readAttachment(blobs, { converter: throwing, llm: eyes }, r, pdf)).rejects.toThrow('binding fault');
    expect(eyes.read).not.toHaveBeenCalled();
    expect(r.recordText).not.toHaveBeenCalled();
  });

  it('reads a picture with the model, and records a decline so it is not asked again', async () => {
    const r = repo();
    expect(await readAttachment(blobs, { llm: vision(said) }, r, photo)).toBe('vision');
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a2', readBy: 'vision' }), { job: 'read', ...cost });

    const declined = repo();
    expect(await readAttachment(blobs, { llm: vision(null) }, declined, photo)).toBe('empty');
    expect(declined.recordText).toHaveBeenCalledWith(expect.objectContaining({ text: '', readBy: 'vision' }), { job: 'read', ...cost });
  });

  it('leaves a picture alone where there is no model, and a PDF alone where there is only a model', async () => {
    const r = repo();
    expect(await readAttachment(blobs, {}, r, photo)).toBe('unread');
    // A PDF's text layer is the browser's to read here; a scan the browser finds empty
    // waits for an Auto-fill press, which is a different entry point (`readPendingFile`).
    const eyes = vision(said);
    expect(await readAttachment(blobs, { llm: eyes }, r, pdf)).toBe('unread');
    expect(eyes.read).not.toHaveBeenCalled();
    expect(r.recordText).not.toHaveBeenCalled();
  });
});

describe('a pass over files already chosen', () => {
  it('takes a never-read scan through the layer and a picture straight to the model, and counts each', async () => {
    const eyes = vision(said);
    const r = repo();
    const counts = await readPendingFiles(
      blobs,
      { converter: converter(`# scan.pdf\n## Contents\n${prose}`), llm: eyes },
      r,
      [
        { ...pdf, pending: 'text' },
        { ...photo, pending: 'vision' },
      ],
    );
    expect(counts).toEqual({ read: 2, empty: 0, failed: 0, unread: 0 });
    // The scan's layer had text, so only the picture reached the paid reader.
    expect(eyes.read).toHaveBeenCalledTimes(1);
    expect(eyes.read).toHaveBeenCalledWith(expect.objectContaining({ filename: 'card.jpg' }));
  });

  it('closes a file past the caps as the model’s empty answer, and goes on past one that throws', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const eyes = vision(said);
    const r = repo();
    const missing: BlobStore = { get: async (key) => (key === 'gone' ? null : blobs.get(key)) };
    const counts = await readPendingFiles(missing, { llm: eyes }, r, [
      { ...photo, id: 'big', size: 100 * 1024 * 1024, pending: 'vision' },
      { ...photo, id: 'lost', r2Key: 'gone', pending: 'vision' },
      { ...photo, pending: 'vision' },
    ]);
    expect(counts).toEqual({ read: 1, empty: 1, failed: 1, unread: 0 });
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'big', text: '', readBy: 'vision' }));
    expect(eyes.read).toHaveBeenCalledTimes(1);
    // The id is what gets logged, never the filename.
    expect(quiet).toHaveBeenCalledWith('read:', 'lost', expect.any(String));
    quiet.mockRestore();
  });

  it('leaves an assistant’s words standing when the model declines, and replaces them when it reads', async () => {
    const declined = repo();
    const counts = await readPendingFiles(blobs, { llm: vision(null) }, declined, [{ ...photo, pending: 'vision', writtenBy: 'assistant' }]);
    expect(counts).toEqual({ read: 0, empty: 1, failed: 0, unread: 0 });
    expect(declined.recordText).not.toHaveBeenCalled();

    const read = repo();
    await readPendingFiles(blobs, { llm: vision(said) }, read, [{ ...photo, pending: 'vision', writtenBy: 'assistant' }]);
    expect(read.recordText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a2', readBy: 'vision' }), { job: 'read', ...cost });
  });

  it('counts with the press what a reading cost when there is no text to carry it', async () => {
    // A decline over an assistant's words writes nothing, and a reply cut off at its budget
    // throws, but both were paid for (MAK-180).
    const usage = new PressUsage();
    await readPendingFiles(blobs, { llm: vision(null), usage }, repo(), [{ ...photo, pending: 'vision', writtenBy: 'assistant' }]);
    const cut: Pick<LanguageModel, 'read'> = {
      read: async () => {
        throw new LlmError(0, 'ran out of room', { ...cost, outputTokens: 16384 });
      },
    };
    const r = repo();
    const counts = await readPendingFiles(blobs, { llm: cut, usage }, r, [{ ...photo, pending: 'vision' }]);
    expect(counts.failed).toBe(1);
    expect(r.recordText).not.toHaveBeenCalled();
    // And a reading whose text could not be written: the store was away, the model was paid.
    const away = { recordText: vi.fn(async () => { throw new Error('store unavailable'); }) };
    expect((await readPendingFiles(blobs, { llm: vision(said), usage }, away, [{ ...photo, pending: 'vision' }])).failed).toBe(1);
    expect(usage.entries).toEqual([
      { job: 'read', ...cost },
      { job: 'read', ...cost, outputTokens: 16384 },
      { job: 'read', ...cost },
    ]);
  });

  it('leaves every file alone where no reader here takes it', async () => {
    const r = repo();
    const counts = await readPendingFiles(blobs, {}, r, [
      { ...photo, pending: 'vision' },
      { ...pdf, pending: 'text' },
    ]);
    expect(counts).toEqual({ read: 0, empty: 0, failed: 0, unread: 2 });
    expect(r.recordText).not.toHaveBeenCalled();
  });
});
