// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GONE_DAYS, planPrune } from './prune-plan.mjs';

/** @param {Record<string, string>} gone */
const state = (gone) => /** @type {const} */ ({ version: 1, gone });

test('the threshold is 55 days', () => {
  assert.equal(GONE_DAYS, 55);
});

test('a key first seen gone today is recorded with today and not removed', () => {
  const plan = planPrune({
    live: ['a.pdf'],
    mirror: ['a.pdf', 'b.pdf'],
    state: state({}),
    today: '2026-10-06',
  });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.state, state({ 'b.pdf': '2026-10-06' }));
});

test('a recorded key that reappears in live is dropped from the state', () => {
  const plan = planPrune({
    live: ['a.pdf', 'b.pdf'],
    mirror: ['a.pdf', 'b.pdf'],
    state: state({ 'b.pdf': '2026-08-01' }),
    today: '2026-10-06',
  });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.state, state({}));
});

test('an already recorded key keeps its original date', () => {
  const plan = planPrune({
    live: ['a.pdf'],
    mirror: ['a.pdf', 'b.pdf'],
    state: state({ 'b.pdf': '2026-09-20' }),
    today: '2026-10-06',
  });
  assert.deepEqual(plan.state, state({ 'b.pdf': '2026-09-20' }));
});

test('54 days gone is kept, 55 days gone is removed', () => {
  // 2026-10-06 minus 54 days is 2026-08-13; minus 55 is 2026-08-12.
  const kept = planPrune({
    live: ['a.pdf'],
    mirror: ['a.pdf', 'b.pdf'],
    state: state({ 'b.pdf': '2026-08-13' }),
    today: '2026-10-06',
  });
  assert.deepEqual(kept.remove, []);
  assert.deepEqual(kept.state, state({ 'b.pdf': '2026-08-13' }));

  const removed = planPrune({
    live: ['a.pdf'],
    mirror: ['a.pdf', 'b.pdf'],
    state: state({ 'b.pdf': '2026-08-12' }),
    today: '2026-10-06',
  });
  assert.deepEqual(removed.remove, ['b.pdf']);
  assert.deepEqual(removed.state, state({}));
});

test('the boundary holds across a month and a year boundary', () => {
  // 2026-01-05 minus 55 days is 2025-11-11 (November has 30 days, December 31).
  const input = { live: ['a'], mirror: ['a', 'b'], today: '2026-01-05' };
  assert.deepEqual(
    planPrune({ ...input, state: state({ b: '2025-11-11' }) }).remove,
    ['b'],
  );
  assert.deepEqual(
    planPrune({ ...input, state: state({ b: '2025-11-12' }) }).remove,
    [],
  );
  // A leap day counts: 2028-03-01 minus 55 days is 2028-01-06.
  const leap = { live: ['a'], mirror: ['a', 'b'], today: '2028-03-01' };
  assert.deepEqual(
    planPrune({ ...leap, state: state({ b: '2028-01-06' }) }).remove,
    ['b'],
  );
  assert.deepEqual(
    planPrune({ ...leap, state: state({ b: '2028-01-07' }) }).remove,
    [],
  );
});

test('a recorded key in neither listing is dropped from the state', () => {
  const plan = planPrune({
    live: ['a.pdf'],
    mirror: ['a.pdf'],
    state: state({ 'b.pdf': '2026-09-01' }),
    today: '2026-10-06',
  });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.state, state({}));
});

test('a key in live and the mirror is untouched', () => {
  const plan = planPrune({
    live: ['a.pdf', 'c.pdf'],
    mirror: ['a.pdf'],
    state: null,
    today: '2026-10-06',
  });
  assert.deepEqual(plan, { remove: [], state: state({}) });
});

test('a key only in live is not gone', () => {
  const plan = planPrune({
    live: ['a.pdf', 'new.pdf'],
    mirror: ['a.pdf'],
    state: null,
    today: '2026-10-06',
  });
  assert.deepEqual(plan.state, state({}));
});

test('an empty or missing live listing throws', () => {
  const base = { mirror: ['a'], state: null, today: '2026-10-06' };
  assert.throws(() => planPrune({ ...base, live: [] }), /empty/);
  assert.throws(() => planPrune({ ...base, live: /** @type {any} */ (null) }));
  assert.throws(() => planPrune({ ...base, live: /** @type {any} */ ('a') }));
  assert.throws(() => planPrune({ ...base, live: /** @type {any} */ (undefined) }));
});

test('a null state is treated as empty', () => {
  const plan = planPrune({
    live: ['a'],
    mirror: ['a', 'b'],
    state: null,
    today: '2026-10-06',
  });
  assert.deepEqual(plan.state, state({ b: '2026-10-06' }));
  const undef = planPrune({
    live: ['a'],
    mirror: ['a', 'b'],
    state: undefined,
    today: '2026-10-06',
  });
  assert.deepEqual(undef, plan);
});

test('a state with another version throws', () => {
  assert.throws(() =>
    planPrune({
      live: ['a'],
      mirror: ['a'],
      state: /** @type {any} */ ({ version: 2, gone: {} }),
      today: '2026-10-06',
    }),
  );
});

test('keys are compared exactly, case included', () => {
  const plan = planPrune({
    live: ['AB/cd.pdf'],
    mirror: ['AB/cd.pdf', 'ab/cd.pdf'],
    state: null,
    today: '2026-10-06',
  });
  assert.deepEqual(plan.state, state({ 'ab/cd.pdf': '2026-10-06' }));
});

test('remove and the state keys come out sorted', () => {
  const plan = planPrune({
    live: ['live'],
    mirror: ['live', 'z', 'm', 'a', 'y', 'b'],
    state: state({ z: '2020-01-01', a: '2020-01-01', y: '2026-10-01' }),
    today: '2026-10-06',
  });
  assert.deepEqual(plan.remove, ['a', 'z']);
  assert.deepEqual(Object.keys(plan.state.gone), ['b', 'm', 'y']);
});

test('a malformed date in the state throws rather than guessing', () => {
  assert.throws(() =>
    planPrune({
      live: ['a'],
      mirror: ['a', 'b'],
      state: state({ b: '2026-02-31' }),
      today: '2026-10-06',
    }),
  );
  assert.throws(() =>
    planPrune({ live: ['a'], mirror: ['a'], state: null, today: 'yesterday' }),
  );
});
