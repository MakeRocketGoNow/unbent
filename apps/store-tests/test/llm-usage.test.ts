import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { feedSeq, freshStore } from './helpers.js';

/**
 * The usage counter (schema 0007, MAK-180): a press counted against the day's cap in the
 * call that reads the note, a reading's tokens in the write that records its text, the
 * rest of a press's in one call after, and the year read back as one answer.
 */

const opus = (job: 'read' | 'title' | 'fields', inputTokens: number, outputTokens: number) => ({
  job,
  model: 'claude-opus-5',
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

async function withNote(label: string) {
  const { stub } = freshStore(label);
  const note = await stub.create({ id: crypto.randomUUID(), title: '', body: 'b', tags: [] });
  await stub.recordAttachment({ id: 'a1', noteId: note.id, filename: 'card.jpg', contentType: 'image/jpeg', size: 3, r2Key: 'k/a1' });
  return { stub, noteId: note.id };
}

describe('the usage counter', () => {
  it('holds the counts of one press: the press, its reading, its title and its fields', async () => {
    const { stub, noteId } = await withNote('usage-press');
    const prelude = await stub.autofillPrelude(noteId, 5, { cap: null });
    expect(prelude?.press).toEqual({ allowed: true, today: 1 });
    expect(prelude?.forVision.map((f) => f.id)).toEqual(['a1']);

    await stub.recordText({ attachmentId: 'a1', noteId, filename: 'card.jpg', text: 'A card', readBy: 'vision' }, opus('read', 1500, 300));
    await stub.recordLlmUsage([opus('title', 400, 20), opus('fields', 450, 30)]);

    const usage = await stub.autofillUsage();
    expect(usage.year).toBe(new Date().getUTCFullYear());
    expect(usage.presses).toBe(1);
    expect(usage.today).toBe(1);
    expect(usage.models.sort((a, b) => a.job.localeCompare(b.job))).toEqual([
      { ...opus('fields', 450, 30), requests: 1 },
      { ...opus('read', 1500, 300), requests: 1 },
      { ...opus('title', 400, 20), requests: 1 },
    ]);
  });

  it('adds a second answer to the same day, job and model, and keeps another model apart', async () => {
    const { stub } = freshStore('usage-sum');
    await stub.recordLlmUsage([opus('title', 400, 20), opus('title', 100, 5), { ...opus('title', 50, 2), model: 'claude-sonnet-5' }]);
    const { models } = await stub.autofillUsage();
    expect(models.sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      { ...opus('title', 500, 25), requests: 2 },
      { ...opus('title', 50, 2), model: 'claude-sonnet-5', requests: 1 },
    ]);
  });

  it('refuses a press past the cap without counting it or reading the files, and lets the last one under through', async () => {
    const { stub, noteId } = await withNote('usage-cap');
    for (let i = 1; i <= 3; i++) expect((await stub.autofillPrelude(noteId, 5, { cap: 3 }))?.press).toEqual({ allowed: true, today: i });
    const refused = await stub.autofillPrelude(noteId, 5, { cap: 3 });
    expect(refused?.press).toEqual({ allowed: false, today: 3 });
    expect(refused?.forVision).toEqual([]);
    expect((await stub.autofillUsage()).presses).toBe(3);
    // A cap raised by a deploy lets the day go on.
    expect((await stub.autofillPrelude(noteId, 5, { cap: 5 }))?.press).toEqual({ allowed: true, today: 4 });
  });

  it('counts nothing for a note that is not there, or when not asked to', async () => {
    const { stub, noteId } = await withNote('usage-none');
    expect(await stub.autofillPrelude(crypto.randomUUID(), 5, { cap: 1 })).toBeNull();
    expect((await stub.autofillPrelude(noteId, 5))?.press).toBeNull();
    expect((await stub.autofillUsage()).presses).toBe(0);
  });

  it('writes nothing to the feed, while the text a reading records still does', async () => {
    const { stub, noteId } = await withNote('usage-feed');
    const before = await feedSeq(stub);
    await stub.autofillPrelude(noteId, 5, { cap: null });
    await stub.recordLlmUsage([opus('title', 1, 1)]);
    expect(await feedSeq(stub)).toBe(before);
    await stub.recordText({ attachmentId: 'a1', noteId, filename: 'card.jpg', text: 'A card', readBy: 'vision' }, opus('read', 1, 1));
    expect(await feedSeq(stub)).toBe(before + 1);
  });

  it('reads this year and not the last, and today’s presses apart from the year’s', async () => {
    const { stub } = freshStore('usage-year');
    const year = new Date().getUTCFullYear();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'press', '', 7, 0)`, `${year - 1}-12-31`);
      sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'read', 'm', 2, 9000)`, `${year - 1}-12-31`);
      sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'press', '', 4, 0)`, `${year}-01-01`);
      sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'read', 'm', 1, 100)`, `${year}-01-01`);
    });
    await stub.recordLlmUsage([]);
    const usage = await stub.autofillUsage();
    const isNewYearsDay = new Date().toISOString().slice(5, 10) === '01-01';
    expect(usage.presses).toBe(4);
    expect(usage.today).toBe(isNewYearsDay ? 4 : 0);
    expect(usage.models).toEqual([{ job: 'read', model: 'm', requests: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
  });
});
