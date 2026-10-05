import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_API_URL,
  MAX_LLM_IMAGE_BYTES,
  MAX_LLM_PDF_BYTES,
  LLM_MODEL_DEFAULT,
  LlmError,
  canUseLlm,
  formatReading,
  isLlmAuthError,
  readableByLlm,
  llmFrom,
} from './llm.js';

const env = { ANTHROPIC_API_KEY: 'sk-test' };
const bytes = new TextEncoder().encode('not really a jpeg').buffer as ArrayBuffer;
const photo = { filename: 'card.jpg', contentType: 'image/jpeg', bytes };

const said = {
  name: 'Acme Plumbing business card',
  kind: 'business card',
  description: 'A business card for a plumber at Acme Plumbing, with a phone number and email.',
  text: 'ACME PLUMBING\nJane Doe, Owner\n(612) 555-0148',
};

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

function message(text: string, stop_reason = 'end_turn') {
  return { id: 'msg_1', type: 'message', role: 'assistant', stop_reason, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

describe('vision', () => {
  it('is on when there is a key, and only then', () => {
    expect(canUseLlm({})).toBe(false);
    expect(canUseLlm({ ANTHROPIC_API_KEY: ' ' })).toBe(false);
    expect(canUseLlm(env)).toBe(true);
    expect(() => llmFrom({})).toThrow();
  });

  it('reads a standing misconfiguration off an LlmError: a 401 or 403, nothing else', () => {
    expect(isLlmAuthError(new LlmError(401, 'invalid x-api-key'))).toBe(true);
    expect(isLlmAuthError(new LlmError(403, 'this key cannot use that model'))).toBe(true);
    // Passing failures, which retrying would clear — not a fault to fix.
    for (const status of [0, 400, 404, 429, 500, 529]) {
      expect(isLlmAuthError(new LlmError(status, 'x'))).toBe(false);
    }
    // Not an LlmError at all.
    expect(isLlmAuthError(new Error('boom'))).toBe(false);
    expect(isLlmAuthError(null)).toBe(false);
  });

  it('takes pictures and PDFs under their caps, and nothing else', () => {
    expect(readableByLlm('image/jpeg', 1000)).toBe(true);
    expect(readableByLlm('image/webp', MAX_LLM_IMAGE_BYTES + 1)).toBe(false);
    expect(readableByLlm('application/pdf', 1000)).toBe(true);
    expect(readableByLlm('application/pdf', MAX_LLM_PDF_BYTES + 1)).toBe(false);
    expect(readableByLlm('image/svg+xml', 10)).toBe(false);
    expect(readableByLlm('text/plain', 10)).toBe(false);
  });

  it('sends the picture before the words, with the key and the shape to fill in', async () => {
    const fetchImpl = answering(200, message(JSON.stringify(said)));
    const vision = llmFrom(env, fetchImpl as unknown as typeof fetch);
    const reading = await vision.read(photo);

    expect(reading).toEqual(said);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_API_URL);
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe(LLM_MODEL_DEFAULT);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toEqual(['name', 'kind', 'description', 'text']);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    const [first, second] = body.messages[0].content;
    expect(first).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: btoa('not really a jpeg') },
    });
    expect(second.type).toBe('text');
    expect(second.text).toContain('card.jpg');
  });

  it('sends a PDF as a document, and asks the model it is told to', async () => {
    const fetchImpl = answering(200, message(JSON.stringify(said)));
    const vision = llmFrom({ ...env, ANTHROPIC_MODEL: 'claude-sonnet-5', ANTHROPIC_API_URL: 'http://localhost:9/v1/messages' }, fetchImpl as unknown as typeof fetch);
    await vision.read({ filename: 'scan.pdf', contentType: 'application/pdf', bytes });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:9/v1/messages');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
  });

  it('reads a decline as no reading, whether it comes as a stop reason or as prose', async () => {
    const refused = llmFrom(env, answering(200, message('', 'refusal')) as unknown as typeof fetch);
    expect(await refused.read(photo)).toBeNull();
    const prose = llmFrom(env, answering(200, message('I cannot help with that image.')) as unknown as typeof fetch);
    expect(await prose.read(photo)).toBeNull();
  });

  it('says why the API refused, with the status', async () => {
    const vision = llmFrom(env, answering(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) as unknown as typeof fetch);
    const failed = vision.read(photo);
    await expect(failed).rejects.toBeInstanceOf(LlmError);
    await expect(failed).rejects.toMatchObject({ status: 401, message: expect.stringContaining('invalid x-api-key') });
  });

  it('tries once more when the API is overloaded', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(message(JSON.stringify(said))), { status: 200 }));
    const vision = llmFrom(env, fetchImpl as unknown as typeof fetch);
    expect(await vision.read(photo)).toEqual(said);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('writes a title for a note from what it and its files say', async () => {
    const fetchImpl = answering(200, message(JSON.stringify({ title: '  Acme Hardware invoice, March 2026 ' })));
    const llm = llmFrom(env, fetchImpl as unknown as typeof fetch);
    const note = { title: '', body: 'Paid.', attachments: [{ filename: 'scan.pdf', text: 'ACME HARDWARE\nInvoice #4471' }] };
    expect(await llm.title(note)).toBe('Acme Hardware invoice, March 2026');

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe(LLM_MODEL_DEFAULT);
    expect(body.max_tokens).toBeLessThanOrEqual(1024);
    expect(body.system).toContain('title');
    expect(JSON.parse(body.messages[0].content)).toEqual(note);
    expect(body.output_config.format.schema.required).toEqual(['title']);
    // Low effort for the default model, whose parameters this code knows.
    expect(body.output_config.effort).toBe('low');
  });

  it('sends a model the operator named the plain request', async () => {
    const fetchImpl = answering(200, message(JSON.stringify({ title: 'x' })));
    const llm = llmFrom({ ...env, ANTHROPIC_MODEL: 'claude-sonnet-5' }, fetchImpl as unknown as typeof fetch);
    await llm.title({ title: '', body: 'x', attachments: [] });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.output_config.effort).toBeUndefined();
    expect(body.output_config.format.type).toBe('json_schema');
  });

  it('treats an answer cut off by the token budget as an error, not a decline', async () => {
    // A decline is recorded and never asked again; a cut-off answer must stay pending.
    const cut = llmFrom(env, answering(200, message('{"title": "Acme', 'max_tokens')) as unknown as typeof fetch);
    await expect(cut.title({ title: '', body: 'x', attachments: [] })).rejects.toBeInstanceOf(LlmError);
    await expect(cut.read(photo)).rejects.toMatchObject({ message: expect.stringContaining('ran out of room') });
  });

  it('writes the values of text fields, keyed as asked, from a schema of those keys', async () => {
    const fetchImpl = answering(200, message(JSON.stringify({ field_0: '  Acme   Rentals ', field_1: '' })));
    const llm = llmFrom(env, fetchImpl as unknown as typeof fetch);
    const note = { title: '', body: '', attachments: [{ filename: 'sale.pdf', text: 'Acme Rentals\nOrder #: 112-0042' }] };
    const fields = [
      { key: 'field_0', name: 'Vendor' },
      { key: 'field_1', name: 'Order number' },
    ];
    // Spacing collapsed; an empty string is the model saying the note does not say.
    expect(await llm.textFields(note, fields)).toEqual({ field_0: 'Acme Rentals', field_1: '' });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(JSON.parse(body.messages[0].content)).toEqual({
      note,
      fields: [
        { key: 'field_0', field: 'Vendor' },
        { key: 'field_1', field: 'Order number' },
      ],
    });
    const { schema } = body.output_config.format;
    expect(schema.required).toEqual(['field_0', 'field_1']);
    expect(schema.properties.field_0.description).toContain('Vendor');
    expect(body.system).toContain('never write one it does not contain');
  });

  it('asks nothing for no fields, and answers null for a decline', async () => {
    const fetchImpl = answering(200, message('', 'refusal'));
    const llm = llmFrom(env, fetchImpl as unknown as typeof fetch);
    const note = { title: '', body: 'x', attachments: [] };
    expect(await llm.textFields(note, [])).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await llm.textFields(note, [{ key: 'field_0', name: 'Vendor' }])).toBeNull();
  });

  it('answers no title for a decline or an empty answer', async () => {
    const declined = llmFrom(env, answering(200, message('', 'refusal')) as unknown as typeof fetch);
    expect(await declined.title({ title: '', body: 'x', attachments: [] })).toBeNull();
    const blank = llmFrom(env, answering(200, message(JSON.stringify({ title: '   ' }))) as unknown as typeof fetch);
    expect(await blank.title({ title: '', body: 'x', attachments: [] })).toBeNull();
  });

  it('lays the reading out as the file’s text: the name, the kind and description, then the words', () => {
    expect(formatReading(said)).toBe(
      'Acme Plumbing business card\n' +
        'Business card: A business card for a plumber at Acme Plumbing, with a phone number and email.\n' +
        '\n' +
        'ACME PLUMBING\nJane Doe, Owner\n(612) 555-0148',
    );
    expect(formatReading({ name: 'Lunch', kind: '', description: 'A plate of pasta.', text: '' })).toBe('Lunch\nA plate of pasta.');
  });
});
