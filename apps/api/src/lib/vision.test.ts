import { describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_API_URL,
  MAX_VISION_IMAGE_BYTES,
  MAX_VISION_PDF_BYTES,
  VISION_MODEL_DEFAULT,
  VisionError,
  canReadImages,
  formatReading,
  readableByVision,
  visionFrom,
} from './vision.js';

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
    expect(canReadImages({})).toBe(false);
    expect(canReadImages({ ANTHROPIC_API_KEY: ' ' })).toBe(false);
    expect(canReadImages(env)).toBe(true);
    expect(() => visionFrom({})).toThrow();
  });

  it('takes pictures and PDFs under their caps, and nothing else', () => {
    expect(readableByVision('image/jpeg', 1000)).toBe(true);
    expect(readableByVision('image/webp', MAX_VISION_IMAGE_BYTES + 1)).toBe(false);
    expect(readableByVision('application/pdf', 1000)).toBe(true);
    expect(readableByVision('application/pdf', MAX_VISION_PDF_BYTES + 1)).toBe(false);
    expect(readableByVision('image/svg+xml', 10)).toBe(false);
    expect(readableByVision('text/plain', 10)).toBe(false);
  });

  it('sends the picture before the words, with the key and the shape to fill in', async () => {
    const fetchImpl = answering(200, message(JSON.stringify(said)));
    const vision = visionFrom(env, fetchImpl as unknown as typeof fetch);
    const reading = await vision.read(photo);

    expect(reading).toEqual(said);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_API_URL);
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe(VISION_MODEL_DEFAULT);
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
    const vision = visionFrom({ ...env, VISION_MODEL: 'claude-sonnet-5', ANTHROPIC_API_URL: 'http://localhost:9/v1/messages' }, fetchImpl as unknown as typeof fetch);
    await vision.read({ filename: 'scan.pdf', contentType: 'application/pdf', bytes });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:9/v1/messages');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
  });

  it('reads a decline as no reading, whether it comes as a stop reason or as prose', async () => {
    const refused = visionFrom(env, answering(200, message('', 'refusal')) as unknown as typeof fetch);
    expect(await refused.read(photo)).toBeNull();
    const prose = visionFrom(env, answering(200, message('I cannot help with that image.')) as unknown as typeof fetch);
    expect(await prose.read(photo)).toBeNull();
  });

  it('says why the API refused, with the status', async () => {
    const vision = visionFrom(env, answering(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) as unknown as typeof fetch);
    const failed = vision.read(photo);
    await expect(failed).rejects.toBeInstanceOf(VisionError);
    await expect(failed).rejects.toMatchObject({ status: 401, message: expect.stringContaining('invalid x-api-key') });
  });

  it('tries once more when the API is overloaded', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(message(JSON.stringify(said))), { status: 200 }));
    const vision = visionFrom(env, fetchImpl as unknown as typeof fetch);
    expect(await vision.read(photo)).toEqual(said);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

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
