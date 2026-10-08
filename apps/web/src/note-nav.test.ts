import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ParsedLocation } from '@tanstack/react-router';
import { isListPath, isNotePath, noteTransitionTypes, slideFor, watchHistoryMoves } from './note-nav.js';

/** As much of a router location as the decision reads. */
function at(pathname: string, index = 0, key = `k${index}`): ParsedLocation {
  return { pathname, state: { __TSR_index: index, __TSR_key: key } } as unknown as ParsedLocation;
}

function phone(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on, media: query }));
}

/** A history move the page did not make, arriving at the entry `key`. */
function popTo(key: string, opts: { drawn?: boolean } = {}) {
  const e = new PopStateEvent('popstate', { state: { __TSR_key: key } });
  if (opts.drawn) Object.defineProperty(e, 'hasUAVisualTransition', { value: true });
  window.dispatchEvent(e);
}

beforeAll(() => watchHistoryMoves());

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.UnbentApp;
});

describe('the paths', () => {
  it('tells a list from a note, in the notes view and the trash', () => {
    expect(isListPath('/notes')).toBe(true);
    expect(isListPath('/trash/')).toBe(true);
    expect(isNotePath('/notes/n1')).toBe(true);
    expect(isNotePath('/trash/n1')).toBe(true);
    expect(isListPath('/notes/n1')).toBe(false);
    expect(isNotePath('/notes')).toBe(false);
    expect(isNotePath('/settings/notebooks')).toBe(false);
    expect(isNotePath('/embed/notes/n1')).toBe(false);
  });
});

describe('slideFor', () => {
  it('slides in going from a list to a note, and back coming out, whichever way the history went', () => {
    expect(slideFor('/notes', '/notes/n1', false)).toBe('note-open');
    expect(slideFor('/notes', '/notes/n1', true)).toBe('note-open');
    expect(slideFor('/notes/n1', '/notes', false)).toBe('note-close');
    expect(slideFor('/trash/n1', '/trash', true)).toBe('note-close');
  });

  it('follows the history from one note to another', () => {
    expect(slideFor('/notes/n1', '/notes/n2', false)).toBe('note-open');
    expect(slideFor('/notes/n2', '/notes/n1', true)).toBe('note-close');
  });

  it('does not slide for a list redrawn with other filters, the same note, or anywhere else', () => {
    expect(slideFor('/notes', '/notes', false)).toBeNull();
    expect(slideFor('/notes/n1', '/notes/n1', true)).toBeNull();
    expect(slideFor('/notes', '/settings', false)).toBeNull();
    expect(slideFor('/settings/notebooks', '/notes/n1', false)).toBeNull();
  });
});

describe('noteTransitionTypes', () => {
  it('names the slide on a phone and nothing on a desktop', () => {
    phone(true);
    expect(noteTransitionTypes({ fromLocation: at('/notes', 1), toLocation: at('/notes/n1', 2) })).toEqual(['note-open']);
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toEqual(['note-close']);
    phone(false);
    expect(noteTransitionTypes({ fromLocation: at('/notes', 1), toLocation: at('/notes/n1', 2) })).toBe(false);
  });

  it('draws nothing for the first page, which has nowhere to slide from', () => {
    phone(true);
    expect(noteTransitionTypes({ toLocation: at('/notes/n1') })).toBe(false);
  });

  it('skips a move the browser has already drawn, and only that one', () => {
    phone(true);
    popTo('k1', { drawn: true });
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toBe(false);
    // The flag answered for that move; the next one slides as usual.
    expect(noteTransitionTypes({ fromLocation: at('/notes', 1), toLocation: at('/notes/n1', 2) })).toEqual(['note-open']);
  });

  it('ignores a drawn move that arrived somewhere else', () => {
    phone(true);
    popTo('elsewhere', { drawn: true });
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toEqual(['note-close']);
  });

  it('slides for a move the browser left undrawn, as Android Back is', () => {
    phone(true);
    popTo('k1');
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toEqual(['note-close']);
  });

  it('takes every history move in the iOS app as the edge swipe, which has drawn itself', () => {
    phone(true);
    window.UnbentApp = { platform: 'ios' } as typeof window.UnbentApp;
    popTo('k1');
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toBe(false);
  });
});
