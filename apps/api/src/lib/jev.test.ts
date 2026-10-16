import { describe, expect, it, vi } from 'vitest';
import { JEV_API_URL, JEV_MODEL, JevError, canAutofill, jevFrom } from './jev.js';

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

const env = { TYPESAFE_API_KEY: 'key-1' };

describe('jev', () => {
  it('is on when there is a key, and only then', () => {
    expect(canAutofill({})).toBe(false);
    expect(canAutofill({ TYPESAFE_API_KEY: '  ' })).toBe(false);
    expect(canAutofill(env)).toBe(true);
    expect(() => jevFrom({})).toThrow();
  });

  it('posts the state and the questions with the key, and reads the answers by shape', async () => {
    const fetchImpl = answering(200, {
      model: 'jev-1.13.0',
      answers: {
        notebook: { type: 'choice', choice: 'Coupons', probabilities: { Coupons: 0.9, none: 0.1 }, confidence: 0.88 },
        tag_0: { noul: 0.2 },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const jev = jevFrom(env, fetchImpl as unknown as typeof fetch);
    const questions = {
      notebook: { type: 'choice' as const, instructions: 'Which?', criteria: { Coupons: 'x', none: 'y' } },
      tag_0: { type: 'noul' as const, instructions: 'Is it?' },
    };
    const answers = await jev.ask({ title: 'Receipt' }, questions);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(JEV_API_URL);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer key-1');
    expect(JSON.parse(init!.body as string)).toEqual({
      state: { title: 'Receipt' },
      model: JEV_MODEL,
      questions,
    });
    expect(answers).toEqual({
      notebook: { type: 'choice', choice: 'Coupons', probabilities: { Coupons: 0.9, none: 0.1 }, confidence: 0.88 },
      tag_0: { type: 'noul', noul: 0.2 },
    });
  });

  it('asks nothing when there is nothing to ask', async () => {
    const fetchImpl = answering(200, { answers: {} });
    const jev = jevFrom(env, fetchImpl as unknown as typeof fetch);
    expect(await jev.ask('x', {})).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('goes where it is pointed', async () => {
    const fetchImpl = answering(200, { answers: {} });
    const jev = jevFrom({ ...env, TYPESAFE_API_URL: 'http://localhost:9999/jev' }, fetchImpl as unknown as typeof fetch);
    await jev.ask('x', { q: { type: 'noul', instructions: 'Is it?' } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:9999/jev');
  });

  it('names the model it is given, for another System One endpoint', async () => {
    const fetchImpl = answering(200, { answers: {} });
    const jev = jevFrom(env, fetchImpl as unknown as typeof fetch, 'other-model');
    await jev.ask('x', { q: { type: 'noul', instructions: 'Is it?' } });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).model).toBe('other-model');
  });

  it('says why the API refused, with the status', async () => {
    const fetchImpl = answering(401, { error: 'invalid api key' });
    const jev = jevFrom(env, fetchImpl as unknown as typeof fetch);
    const failed = jev.ask('x', { q: { type: 'noul', instructions: 'Is it?' } });
    await expect(failed).rejects.toBeInstanceOf(JevError);
    await expect(failed).rejects.toMatchObject({ status: 401, message: expect.stringContaining('invalid api key') });
  });

  it('tries once more after a rate limit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { q: { noul: 0.5 } } }), { status: 200 }));
    const jev = jevFrom(env, fetchImpl as unknown as typeof fetch);
    const answers = await jev.ask('x', { q: { type: 'noul', instructions: 'Is it?' } });
    expect(answers).toEqual({ q: { type: 'noul', noul: 0.5 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('refuses an answer in a shape it does not read rather than guessing at it', async () => {
    const fetchImpl = answering(200, { answers: { q: { verdict: 'yes' } } });
    const jev = jevFrom(env, fetchImpl as unknown as typeof fetch);
    await expect(jev.ask('x', { q: { type: 'noul', instructions: 'Is it?' } })).rejects.toBeInstanceOf(JevError);
  });
});
