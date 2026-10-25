import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { JEV_PRESS_CENTS } from '@unbent/shared';
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
    const prelude = await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: null });
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
    for (let i = 1; i <= 3; i++) expect((await stub.autofillPrelude(noteId, 5, { cap: 3, yearlyCents: null }))?.press).toEqual({ allowed: true, today: i });
    const refused = await stub.autofillPrelude(noteId, 5, { cap: 3, yearlyCents: null });
    expect(refused?.press).toEqual({ allowed: false, today: 3, reason: 'day' });
    expect(refused?.forVision).toEqual([]);
    expect((await stub.autofillUsage()).presses).toBe(3);
    // A cap raised by a deploy lets the day go on.
    expect((await stub.autofillPrelude(noteId, 5, { cap: 5, yearlyCents: null }))?.press).toEqual({ allowed: true, today: 4 });
  });

  it('refuses a press once the year’s spend reaches the cap, and the day’s refusal first', async () => {
    const { stub, noteId } = await withNote('usage-year-cap');
    // A million input tokens on Opus 5.5 is four dollars, by the table in @unbent/shared.
    await stub.recordLlmUsage([{ ...opus('read', 1_000_000, 0), model: 'claude-opus-5-5' }]);
    expect((await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 401 }))?.press).toEqual({ allowed: true, today: 1 });
    // That press cost a tenth of a cent on the decision model, which the sum counts too.
    const refused = await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 400 });
    expect(refused?.press).toEqual({ allowed: false, today: 1, reason: 'year' });
    expect(refused?.forVision).toEqual([]);
    expect((await stub.autofillUsage()).presses).toBe(1);
    // Under the cap by the press's own cost: 400 cents of tokens and one press.
    expect((await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 400 + 2 * JEV_PRESS_CENTS }))?.press).toEqual({ allowed: true, today: 2 });
    // Both limits reached: the day's is the one named.
    expect((await stub.autofillPrelude(noteId, 5, { cap: 2, yearlyCents: 1 }))?.press).toEqual({ allowed: false, today: 2, reason: 'day' });
  });

  it('reads the year’s rows once per wake for the spend, and none when no yearly cap is set', async () => {
    const { stub, noteId } = await withNote('usage-year-rows');
    const year = new Date().getUTCFullYear();
    // A full year of presses and of two models' readings, a row a day each, and last
    // year's rows beside them, which the range must not touch.
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      for (let d = 0; d < 365; d++) {
        const day = new Date(Date.UTC(year, 0, 1 + d)).toISOString().slice(0, 10);
        if (!day.startsWith(String(year))) break;
        sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'press', '', 2, 0)`, day);
        sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'read', 'claude-haiku-5-5', 2, 3000)`, day);
        sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'title', 'claude-haiku-5-5', 2, 800)`, day);
      }
      sql.exec(`INSERT INTO llm_usage (day, job, model, requests, input_tokens) VALUES (?1, 'read', 'claude-haiku-5-5', 2, 3000)`, `${year - 1}-12-31`);
    });
    const rows = async (run: () => Promise<unknown>) => {
      const before = (await stub.counters()).rowsRead;
      await run();
      return (await stub.counters()).rowsRead - before;
    };
    const dayOnly = await rows(() => stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: null }));
    const firstYear = await rows(() => stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 1_000_000 }));
    const nextYear = await rows(() => stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 1_000_000 }));
    // The note and the day's row, a handful; the first check of the year adds its rows,
    // three a day at most here, and nothing of the year before or of any other table.
    expect(dayOnly).toBeLessThanOrEqual(12);
    expect(firstYear - dayOnly).toBeLessThanOrEqual(3 * 365 + 4);
    expect(firstYear - dayOnly).toBeGreaterThan(3 * 300);
    // The sum is kept while the object is awake: the next press reads none of them.
    expect(nextYear).toBeLessThanOrEqual(dayOnly + 2);
  });

  it('keeps the year’s sum in step with what it records, without reading the year again', async () => {
    const { stub, noteId } = await withNote('usage-year-kept');
    // A cent and a half of Opus, then the sum is first taken.
    await stub.recordLlmUsage([{ ...opus('title', 3750, 0), model: 'claude-opus-5-5' }]);
    expect((await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 2 }))?.press?.allowed).toBe(true);
    // Another two cents recorded after it, and the sum knows without the rows: 1.5 + 0.1 + 2 is past 3.
    const before = (await stub.counters()).rowsRead;
    await stub.recordLlmUsage([{ ...opus('fields', 5000, 0), model: 'claude-opus-5-5' }]);
    const refused = await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: 3 });
    expect(refused?.press).toEqual({ allowed: false, today: 1, reason: 'year' });
    expect((await stub.counters()).rowsRead - before).toBeLessThanOrEqual(12);
  });

  it('counts nothing for a note that is not there, or when not asked to', async () => {
    const { stub, noteId } = await withNote('usage-none');
    expect(await stub.autofillPrelude(crypto.randomUUID(), 5, { cap: 1, yearlyCents: null })).toBeNull();
    expect((await stub.autofillPrelude(noteId, 5))?.press).toBeNull();
    expect((await stub.autofillUsage()).presses).toBe(0);
  });

  it('writes nothing to the feed, while the text a reading records still does', async () => {
    const { stub, noteId } = await withNote('usage-feed');
    const before = await feedSeq(stub);
    await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: null });
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

  it('takes presses from the free plan’s pool only while it is passed, refuses past it, and keeps it out of the year', async () => {
    const { stub, noteId } = await withNote('usage-free');
    // A trial's presses (no pool passed) never come out of it.
    await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: null });
    expect((await stub.autofillUsage()).freeUsed).toBe(0);
    const free = { cap: null, yearlyCents: null, freePresses: 2 };
    expect((await stub.autofillPrelude(noteId, 5, free))?.press).toEqual({ allowed: true, today: 2 });
    expect((await stub.autofillPrelude(noteId, 5, free))?.press).toEqual({ allowed: true, today: 3 });
    const refused = await stub.autofillPrelude(noteId, 5, free);
    expect(refused?.press).toEqual({ allowed: false, today: 3, reason: 'free' });
    expect(refused?.forVision).toEqual([]);
    // The day's cap still comes first, and says when it lifts.
    expect((await stub.autofillPrelude(noteId, 5, { ...free, cap: 3 }))?.press).toMatchObject({ allowed: false, reason: 'day' });
    const usage = await stub.autofillUsage();
    expect(usage.freeUsed).toBe(2);
    // The pool's row is not a day, so the year's presses are the presses.
    expect(usage.presses).toBe(3);
    // A subscription takes the account off the pool: nothing passed, nothing refused.
    expect((await stub.autofillPrelude(noteId, 5, { cap: null, yearlyCents: null }))?.press).toEqual({ allowed: true, today: 4 });
  });
});
