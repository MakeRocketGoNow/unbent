import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_API_URL,
  MAX_LLM_IMAGE_BYTES,
  MAX_LLM_PDF_BYTES,
  LLM_MODEL_DEFAULT,
  LLM_READ_EFFORT_DEFAULT,
  LlmError,
  MAX_TRANSCRIBED_WORDS,
  canUseLlm,
  fieldTokens,
  formatReading,
  isLlmAuthError,
  jobSettings,
  readableByLlm,
  llmFrom,
  sniffMediaType,
} from './llm.js';
import { summarize } from '../store/attachments.js';

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
    // Passing failures, which retrying would clear: not a fault to fix.
    for (const status of [0, 400, 404, 429, 500, 529]) {
      expect(isLlmAuthError(new LlmError(status, 'x'))).toBe(false);
    }
    // Not an LlmError at all.
    expect(isLlmAuthError(new Error('boom'))).toBe(false);
    expect(isLlmAuthError(null)).toBe(false);
  });

  it('reads a file\u2019s type off its first bytes', () => {
    const of = (...b: number[]) => new Uint8Array([...b, ...new Array(12).fill(0)]).buffer as ArrayBuffer;
    const text = (t: string) => new TextEncoder().encode(t.padEnd(12, ' ')).buffer as ArrayBuffer;
    expect(sniffMediaType(of(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMediaType(of(0x89, 0x50, 0x4e, 0x47))).toBe('image/png');
    expect(sniffMediaType(text('GIF89a'))).toBe('image/gif');
    expect(sniffMediaType(text('RIFF\0\0\0\0WEBP'))).toBe('image/webp');
    expect(sniffMediaType(text('%PDF-1.7'))).toBe('application/pdf');
    // Anything else is left to the stored type: a HEIC, or bytes too short to tell.
    expect(sniffMediaType(text('\0\0\0\x18ftypheic'))).toBeNull();
    expect(sniffMediaType(new ArrayBuffer(2))).toBeNull();
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
    const { value: reading, usage } = await vision.read(photo);

    expect(reading).toEqual(said);
    // What it cost comes back with it, with the model that was asked (MAK-180).
    expect(usage).toEqual({ model: LLM_MODEL_DEFAULT, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_API_URL);
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe(LLM_MODEL_DEFAULT);
    // An explicit effort on the read, low by default (MAK-182): measured on a real sample
    // to tie medium and high on what it reads, and to be the fastest and cheapest.
    expect(body.output_config.effort).toBe(LLM_READ_EFFORT_DEFAULT);
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
    // A model the operator named gets no effort it did not ask for.
    expect(body.output_config.effort).toBeUndefined();
    expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
  });

  /*
   * Each job has a model of its own, and the read an effort (MAK-182). The table pins
   * what each request names for each shape of configuration, so a change to the defaults
   * or to the fallback is a change here, and an instance that set only `ANTHROPIC_MODEL`
   * keeps what it had.
   */
  it('gives each job its own model, falling back to the shared one and then the default', () => {
    // Nothing set: every job on the default, the small jobs and the read at low effort.
    expect(jobSettings(env)).toEqual({
      read: { model: LLM_MODEL_DEFAULT, effort: LLM_READ_EFFORT_DEFAULT },
      title: { model: LLM_MODEL_DEFAULT, effort: 'low' },
      fields: { model: LLM_MODEL_DEFAULT, effort: 'low' },
    });
    // The one variable an instance may already have set moves every job, and takes the
    // effort guard with it: a named model gets the plain request.
    expect(jobSettings({ ...env, ANTHROPIC_MODEL: 'claude-opus-5-5' })).toEqual({
      read: { model: 'claude-opus-5-5' },
      title: { model: 'claude-opus-5-5' },
      fields: { model: 'claude-opus-5-5' },
    });
    // A job's own variable wins over the shared one; the others keep falling back.
    expect(jobSettings({ ...env, ANTHROPIC_MODEL: 'claude-opus-5-5', ANTHROPIC_READ_MODEL: 'claude-sonnet-5-5', ANTHROPIC_TITLE_MODEL: ' ' })).toEqual({
      read: { model: 'claude-sonnet-5-5' },
      title: { model: 'claude-opus-5-5' },
      fields: { model: 'claude-opus-5-5' },
    });
    // The careful reader an operator with handwriting wants, with the small jobs left cheap.
    expect(jobSettings({ ...env, ANTHROPIC_READ_MODEL: 'claude-sonnet-5-5', ANTHROPIC_FIELDS_MODEL: LLM_MODEL_DEFAULT })).toEqual({
      read: { model: 'claude-sonnet-5-5' },
      title: { model: LLM_MODEL_DEFAULT, effort: 'low' },
      fields: { model: LLM_MODEL_DEFAULT, effort: 'low' },
    });
    // The read's effort is a variable of its own, sent to whatever model reads (which is
    // what keeps Sonnet's thinking out of a long scan's output budget) and passed through
    // as named, like a model id.
    expect(jobSettings({ ...env, ANTHROPIC_READ_EFFORT: 'medium' }).read).toEqual({ model: LLM_MODEL_DEFAULT, effort: 'medium' });
    expect(jobSettings({ ...env, ANTHROPIC_READ_MODEL: 'claude-sonnet-5-5', ANTHROPIC_READ_EFFORT: ' low ' }).read).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('asks each job of its own model, and counts the tokens against that model', async () => {
    const split = { ...env, ANTHROPIC_READ_MODEL: 'claude-sonnet-5-5', ANTHROPIC_READ_EFFORT: 'high', ANTHROPIC_FIELDS_MODEL: 'claude-opus-5-5' };
    const fetchImpl = answering(200, message(JSON.stringify({ ...said, title: 'x', field_0: 'y' })));
    const llm = llmFrom(split, fetchImpl as unknown as typeof fetch);
    const note = { title: '', body: 'x', attachments: [] };

    const read = await llm.read(photo);
    const title = await llm.title(note);
    const fields = await llm.textFields(note, [{ key: 'field_0', name: 'Vendor' }]);
    const sent = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(sent.map((b) => [b.model, b.output_config.effort])).toEqual([
      ['claude-sonnet-5-5', 'high'],
      [LLM_MODEL_DEFAULT, 'low'],
      ['claude-opus-5-5', undefined],
    ]);
    // The counter keys on the model (0007-llm-usage), so each job's usage names its own.
    expect(read.usage.model).toBe('claude-sonnet-5-5');
    expect(title.usage.model).toBe(LLM_MODEL_DEFAULT);
    expect(fields.usage.model).toBe('claude-opus-5-5');
    // Nothing asked still says which model would have been.
    expect((await llm.textFields(note, [])).usage.model).toBe('claude-opus-5-5');
  });

  it('sends a file as what its bytes are, not as what the upload called it', async () => {
    // A PNG stored as image/jpeg, the way Evernote's snapshots arrive: the API refuses an
    // image whose bytes and type disagree, so this file could never be read.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).buffer as ArrayBuffer;
    const fetchImpl = answering(200, message(JSON.stringify(said)));
    await llmFrom(env, fetchImpl as unknown as typeof fetch).read({ filename: 'Snapshot.png', contentType: 'image/jpeg', bytes: png });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
  });

  it('tells the model where a long transcription stops, short of the output budget', async () => {
    const fetchImpl = answering(200, message(JSON.stringify(said)));
    await llmFrom(env, fetchImpl as unknown as typeof fetch).read(photo);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.system).toContain(`past about ${MAX_TRANSCRIBED_WORDS.toLocaleString('en-US')} words`);
    // About 1.4 tokens a word, with the thinking beside it: the cap must leave most of the
    // budget free, or a long scan runs out of room and is paid for on every press.
    expect(MAX_TRANSCRIBED_WORDS * 1.4).toBeLessThan(body.max_tokens / 2);
  });

  it('reads a decline as no reading, whether it comes as a stop reason or as prose', async () => {
    const refused = llmFrom(env, answering(200, message('', 'refusal')) as unknown as typeof fetch);
    expect((await refused.read(photo)).value).toBeNull();
    const prose = llmFrom(env, answering(200, message('I cannot help with that image.')) as unknown as typeof fetch);
    expect((await prose.read(photo)).value).toBeNull();
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
    expect((await vision.read(photo)).value).toEqual(said);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('writes a title for a note from what it and its files say', async () => {
    const fetchImpl = answering(200, message(JSON.stringify({ title: '  Acme Hardware invoice, March 2026 ' })));
    const llm = llmFrom(env, fetchImpl as unknown as typeof fetch);
    const note = { title: '', body: 'Paid.', attachments: [{ filename: 'scan.pdf', text: 'ACME HARDWARE\nInvoice #4471' }] };
    expect((await llm.title(note)).value).toBe('Acme Hardware invoice, March 2026');

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

  it('gives a title twenty seconds and a reading two minutes', async () => {
    // The press waits for the title, and Jev's pick stands in for one that never comes;
    // a long scan has no stand-in and takes as long as it takes (MAK-175).
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const titling = llmFrom(env, answering(200, message(JSON.stringify({ title: 'x' }))) as unknown as typeof fetch);
      await titling.title({ title: '', body: 'x', attachments: [] });
      expect(timeout).toHaveBeenLastCalledWith(20_000);

      const reader = llmFrom(env, answering(200, message(JSON.stringify(said))) as unknown as typeof fetch);
      await reader.read(photo);
      expect(timeout).toHaveBeenLastCalledWith(120_000);
    } finally {
      timeout.mockRestore();
    }
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
    // It was paid for all the same, so the error carries what it cost.
    await expect(cut.read(photo)).rejects.toMatchObject({ usage: { inputTokens: 1, outputTokens: 1 } });
  });

  it('reads all four of the API\u2019s counts, and zero for any it leaves out', async () => {
    const counted = { ...message(JSON.stringify({ title: 'X' })), usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 } };
    const llm = llmFrom({ ...env, ANTHROPIC_MODEL: 'claude-sonnet-5' }, answering(200, counted) as unknown as typeof fetch);
    expect((await llm.title({ title: '', body: 'x', attachments: [] })).usage).toEqual({
      model: 'claude-sonnet-5',
      inputTokens: 900,
      outputTokens: 40,
      cacheReadTokens: 300,
      cacheWriteTokens: 20,
    });
    const silent = { ...message(JSON.stringify({ title: 'X' })), usage: undefined };
    const quiet = llmFrom(env, answering(200, silent) as unknown as typeof fetch);
    expect((await quiet.title({ title: '', body: 'x', attachments: [] })).usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    const odd = { ...message(JSON.stringify({ title: 'X' })), usage: { input_tokens: '12', output_tokens: -1 } };
    const strange = llmFrom(env, answering(200, odd) as unknown as typeof fetch);
    expect(await strange.title({ title: '', body: 'x', attachments: [] })).toMatchObject({ value: 'X', usage: { inputTokens: 0, outputTokens: 0 } });
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
    expect((await llm.textFields(note, fields)).value).toEqual({ field_0: 'Acme Rentals', field_1: '' });

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
    // Room that grows with the fields asked, past a title's.
    expect(body.max_tokens).toBe(fieldTokens(2));
    expect(fieldTokens(10)).toBeGreaterThan(fieldTokens(2));
  });

  it('asks nothing for no fields, and answers null for a decline', async () => {
    const fetchImpl = answering(200, message('', 'refusal'));
    const llm = llmFrom(env, fetchImpl as unknown as typeof fetch);
    const note = { title: '', body: 'x', attachments: [] };
    expect((await llm.textFields(note, [])).value).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await llm.textFields(note, [{ key: 'field_0', name: 'Vendor' }])).value).toBeNull();
  });

  it('answers no title for a decline or an empty answer', async () => {
    const declined = llmFrom(env, answering(200, message('', 'refusal')) as unknown as typeof fetch);
    expect((await declined.title({ title: '', body: 'x', attachments: [] })).value).toBeNull();
    const blank = llmFrom(env, answering(200, message(JSON.stringify({ title: '   ' }))) as unknown as typeof fetch);
    expect((await blank.title({ title: '', body: 'x', attachments: [] })).value).toBeNull();
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

  /*
   * The store cuts a file's summary out of this layout (`summarize`, MAK-172) without
   * importing it: everything before the first blank line is the name and the description,
   * and the transcription after it is left out. This runs the real layout through the real
   * cut, so a reading laid out differently fails here rather than quietly putting a
   * receipt's every line, or nothing, into list_notes.
   */
  it('lays the reading out so the store can cut its summary from the head', () => {
    const head = (reading: Parameters<typeof formatReading>[0]) => summarize('image/jpeg', formatReading(reading), 'vision');
    expect(head(said)).toEqual({
      read: 'vision',
      summary:
        'Acme Plumbing business card — Business card: A business card for a plumber at Acme Plumbing, with a phone number and email.',
    });
    // No transcription, no kind, no name: each still leaves a summary and never the text.
    expect(head({ ...said, text: '' }).summary).toBe(head(said).summary);
    expect(head({ name: 'Lunch', kind: '', description: 'A plate of pasta.', text: 'MENU' }).summary).toBe('Lunch — A plate of pasta.');
    expect(head({ ...said, name: '' }).summary).toBe(
      'Business card: A business card for a plumber at Acme Plumbing, with a phone number and email.',
    );
  });
});
