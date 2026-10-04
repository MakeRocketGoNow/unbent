import { afterEach, describe, expect, it } from 'vitest';
import {
  FIRST_RUN_WINDOW_MS,
  createdAtMs,
  firstNoteOpened,
  rememberFirstNoteOpened,
  shouldOpenFirstNote,
  type FirstRun,
} from './first-run.js';

const now = Date.parse('2026-10-04T12:00:00Z');
/** A brand-new account on a desktop, at All notes, holding its one note. */
const arriving: FirstRun = {
  twoPane: true,
  wholeAccount: true,
  createdAt: now - 30_000,
  now,
  total: 1,
  alreadyOpened: false,
  newRequested: false,
};

describe('shouldOpenFirstNote', () => {
  it('opens the note for a brand-new account on a desktop', () => {
    expect(shouldOpenFirstNote(arriving)).toBe(true);
  });

  it('leaves a phone on its list', () => {
    expect(shouldOpenFirstNote({ ...arriving, twoPane: false })).toBe(false);
  });

  it('leaves a notebook, a filter or a search alone', () => {
    expect(shouldOpenFirstNote({ ...arriving, wholeAccount: false })).toBe(false);
  });

  it('is only for an account made in the last ten minutes', () => {
    expect(shouldOpenFirstNote({ ...arriving, createdAt: now - FIRST_RUN_WINDOW_MS + 1 })).toBe(true);
    expect(shouldOpenFirstNote({ ...arriving, createdAt: now - FIRST_RUN_WINDOW_MS })).toBe(false);
    expect(shouldOpenFirstNote({ ...arriving, createdAt: now - 30 * 24 * 60 * 60 * 1000 })).toBe(false);
  });

  /** The device's remembered session carries no creation date: no guess is made. */
  it('does nothing when the session does not say when the account was made', () => {
    expect(shouldOpenFirstNote({ ...arriving, createdAt: null })).toBe(false);
  });

  it('wants exactly one note, and a library known to be whole', () => {
    expect(shouldOpenFirstNote({ ...arriving, total: null })).toBe(false);
    expect(shouldOpenFirstNote({ ...arriving, total: 0 })).toBe(false);
    expect(shouldOpenFirstNote({ ...arriving, total: 2 })).toBe(false);
  });

  /** `/notes?new=1` opens a note of its own; the two must not race for the address. */
  it('stands down while a new note is being asked for', () => {
    expect(shouldOpenFirstNote({ ...arriving, newRequested: true })).toBe(false);
  });

  it('happens once', () => {
    expect(shouldOpenFirstNote({ ...arriving, alreadyOpened: true })).toBe(false);
  });
});

describe('createdAtMs', () => {
  it('reads a Date or the ISO string the session answer carries', () => {
    expect(createdAtMs(new Date(now))).toBe(now);
    expect(createdAtMs('2026-10-04T12:00:00.000Z')).toBe(now);
  });

  it('is null for nothing or nonsense', () => {
    expect(createdAtMs(undefined)).toBeNull();
    expect(createdAtMs('not a date')).toBeNull();
  });
});

describe('remembering it per account', () => {
  afterEach(() => localStorage.clear());

  it('remembers each account on its own', () => {
    expect(firstNoteOpened('a')).toBe(false);
    rememberFirstNoteOpened('a');
    rememberFirstNoteOpened('a');
    expect(firstNoteOpened('a')).toBe(true);
    expect(firstNoteOpened('b')).toBe(false);
    expect(JSON.parse(localStorage.getItem('unbent.firstNoteOpened')!)).toEqual(['a']);
  });

  it('survives a value it did not write', () => {
    localStorage.setItem('unbent.firstNoteOpened', '{not json');
    expect(firstNoteOpened('a')).toBe(false);
    rememberFirstNoteOpened('a');
    expect(firstNoteOpened('a')).toBe(true);
  });
});
