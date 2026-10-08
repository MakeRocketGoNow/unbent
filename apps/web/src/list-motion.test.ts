import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onLocalWrite } from './store/actions.js';
import { followLocalChanges } from './list-motion.js';

/*
 * jsdom lays nothing out and animates nothing, so each row is given the place it stands
 * (by its order in the list, 50px apart) and every animation asked for is recorded.
 */
let writeHere: (() => void) | undefined;
vi.mock('./store/actions.js', () => ({
  onLocalWrite: vi.fn((listener: () => void) => {
    writeHere = listener;
    return () => (writeHere = undefined);
  }),
}));

const ROW = 50;
const animations: Array<{ el: Element; frames: Keyframe[] }> = [];

function rect(top: number, height = ROW): DOMRect {
  return { top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) };
}

function list(ids: string[]): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.getBoundingClientRect = () => rect(0, 400);
  for (const id of ids) ul.appendChild(row(id));
  document.body.appendChild(ul);
  return ul;
}

function row(id: string): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.noteId = id;
  li.textContent = id;
  li.getBoundingClientRect = function (this: HTMLLIElement) {
    const at = [...(this.parentElement?.querySelectorAll(':scope > [data-note-id]') ?? [])].indexOf(this);
    return rect(at * ROW);
  };
  return li;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const moved = (id: string) =>
  animations.filter((a) => (a.el as HTMLElement).dataset.noteId === id).map((a) => a.frames[0]);

beforeEach(() => {
  animations.length = 0;
  Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null) {
    animations.push({ el: this, frames: frames as Keyframe[] });
    return { finished: new Promise(() => {}) } as unknown as Animation;
  };
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('followLocalChanges', () => {
  it('closes up after a row the person removed: the rows under it slide up, and a copy of it closes where it stood', async () => {
    const ul = list(['a', 'b', 'c', 'd']);
    const stop = followLocalChanges(ul);
    writeHere!();
    ul.querySelector('[data-note-id="b"]')!.remove();
    await flush();

    expect(moved('a')).toEqual([]);
    expect(moved('c')).toEqual([{ translate: `0 ${ROW}px` }]);
    expect(moved('d')).toEqual([{ translate: `0 ${ROW}px` }]);
    const ghost = ul.querySelector('.note-ghost') as HTMLElement;
    expect(ghost.textContent).toBe('b');
    expect(ghost.style.top).toBe(`${ROW}px`);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.dataset.noteId).toBeUndefined();
    stop();
  });

  it('fades in a row that arrived, and makes room for it', async () => {
    const ul = list(['a', 'b']);
    const stop = followLocalChanges(ul);
    writeHere!();
    ul.insertBefore(row('new'), ul.firstChild);
    await flush();

    expect(moved('new')).toEqual([{ opacity: 0 }]);
    expect(moved('a')).toEqual([{ translate: `0 ${-ROW}px` }]);
    stop();
  });

  it('moves nothing when the change did not come from a write here — the feed, a filter', async () => {
    const ul = list(['a', 'b', 'c']);
    const stop = followLocalChanges(ul);
    ul.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    expect(animations).toEqual([]);
    expect(ul.querySelector('.note-ghost')).toBeNull();
    stop();
  });

  it('moves nothing with reduced motion asked for', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    const ul = list(['a', 'b', 'c']);
    const stop = followLocalChanges(ul);
    writeHere!();
    ul.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    expect(animations).toEqual([]);
    stop();
  });

  it('stops listening when let go', () => {
    const ul = list(['a']);
    followLocalChanges(ul)();
    expect(writeHere).toBeUndefined();
    expect(onLocalWrite).toHaveBeenCalled();
  });
});
