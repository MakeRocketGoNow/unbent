import { describe, expect, it, vi } from 'vitest';
import type { MarkdownConverter } from './extract-text.js';
import { readAttachment, serverCanRead, type BlobStore, type StoredFile } from './read-attachment.js';
import type { FileReading, LanguageModel } from './llm.js';

const prose =
  'Your diagnosis based on what you shared about how you are feeling is allergic rhinitis, ' +
  'also known as hay fever, and the plan is an antihistamine each morning for two weeks.';

function converter(data: string | null): MarkdownConverter {
  return {
    toMarkdown: () => ({
      transform: async () => (data === null ? { format: 'error', error: 'unreadable' } : { format: 'markdown', data }),
    }),
  };
}

function vision(reading: FileReading | null): Pick<LanguageModel, 'read'> & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => reading) };
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
  it('reads a PDF only where the conversion is bound, and a picture only where the model is', () => {
    expect(serverCanRead({ AI: {} }, 'application/pdf', 10)).toBe(true);
    expect(serverCanRead({}, 'application/pdf', 10)).toBe(false);
    expect(serverCanRead({ ANTHROPIC_API_KEY: 'k' }, 'application/pdf', 10)).toBe(false);
    expect(serverCanRead({ ANTHROPIC_API_KEY: 'k' }, 'image/png', 10)).toBe(true);
    expect(serverCanRead({}, 'image/png', 10)).toBe(false);
    expect(serverCanRead({ ANTHROPIC_API_KEY: 'k' }, 'text/plain', 10)).toBe(false);
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
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('A card'), readBy: 'vision' }));
  });

  it('closes an empty scan as before when there is no model, and leaves an unreadable one pending', async () => {
    const r = repo();
    expect(await readAttachment(blobs, { converter: converter('# x\n## Metadata\n- a=b\n') }, r, pdf)).toBe('empty');
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ text: '', readBy: null }));
    expect(await readAttachment(blobs, { converter: converter(null) }, repo(), pdf)).toBe('unread');
  });

  it('reads a picture with the model, and records a decline so it is not asked again', async () => {
    const r = repo();
    expect(await readAttachment(blobs, { llm: vision(said) }, r, photo)).toBe('vision');
    expect(r.recordText).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'a2', readBy: 'vision' }));

    const declined = repo();
    expect(await readAttachment(blobs, { llm: vision(null) }, declined, photo)).toBe('empty');
    expect(declined.recordText).toHaveBeenCalledWith(expect.objectContaining({ text: '', readBy: 'vision' }));
  });

  it('leaves a picture alone where there is no model, and a PDF alone where there is only a model', async () => {
    const r = repo();
    expect(await readAttachment(blobs, {}, r, photo)).toBe('unread');
    // A PDF's text layer is the browser's to read here; the model gets it only once the
    // browser says the layer was empty, which is a different entry point.
    const eyes = vision(said);
    expect(await readAttachment(blobs, { llm: eyes }, r, pdf)).toBe('vision');
    expect(r.recordText).toHaveBeenCalledTimes(1);
  });
});
