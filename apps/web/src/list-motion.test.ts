import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onLocalWrite, type LocalWrite } from './store/actions.js';
import { followLocalChanges } from './list-motion.js';

/*
 * jsdom lays nothing out and animates nothing, so each row is given the place it stands
 * (by its order in the list, 50px apart) and every animation asked for is recorded.
 */
let listener: ((write: LocalWrite) => void) | undefined;
vi.mock('./store/actions.js', () => ({
  onLocalWrite: vi.fn((l: (write: LocalWrite) => void) => {
    listener = l;
    return () => (listener = undefined);
  }),
}));

/** A write made here, touching `ids`; a filing change unless said otherwise. */
const writeHere = (ids: string[], refiles = true) => listener!({ ids, refiles });

const ROW = 50;
const animations: Array<{ el: Element; frames: Keyframe[] }> = [];

function rect(top: number, height = ROW): DOMRect {
  return { top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) };
}

function list(ids: string[]): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.getBoundingClientRect = () => rect(0, 400);
  // Drawn: jsdom reports no boxes, and a list with none is taken to be hidden.
  ul.getClientRects = () => [rect(0, 400)] as unknown as DOMRectList;
  for (const id of ids) ul.appendChild(row(id));
  document.body.appendChild(ul);
  return ul;
}

function row(id: string): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.noteId = id;
  const link = document.createElement('a');
  link.href = `/notes/${id}`;
  link.id = `row-${id}`;
  link.textContent = id;
  li.appendChild(link);
  li.getBoundingClientRect = function (this: HTMLLIElement) {
    const at = [...(this.parentElement?.querySelectorAll(':scope > [data-note-id], :scope > [data-motion-key]') ?? [])].indexOf(this);
    return rect(at * ROW);
  };
  return li;
}

/** A row after the notes — Load more, the empty line — which moves with them. */
function trailing(key: string): HTMLLIElement {
  const li = row(key);
  delete li.dataset.noteId;
  li.dataset.motionKey = key;
  return li;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const moved = (id: string) =>
  animations
    .filter((a) => (a.el as HTMLElement).dataset.noteId === id || (a.el as HTMLElement).dataset.motionKey === id)
    .map((a) => a.frames[0]);

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
    const { stop } = followLocalChanges(ul);
    writeHere(['b']);
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
    expect(ghost.querySelector('[href], [id]')).toBeNull();
    stop();
  });

  it('fades in a row that arrived, and makes room for it', async () => {
    const ul = list(['a', 'b']);
    const { stop } = followLocalChanges(ul);
    writeHere(['new']);
    ul.insertBefore(row('new'), ul.firstChild);
    await flush();

    expect(moved('new')).toEqual([{ opacity: 0 }]);
    expect(moved('a')).toEqual([{ translate: `0 ${-ROW}px` }]);
    stop();
  });

  it('moves nothing when the change did not come from a write here — the feed, a filter', async () => {
    const ul = list(['a', 'b', 'c']);
    const { stop } = followLocalChanges(ul);
    ul.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    expect(animations).toEqual([]);
    expect(ul.querySelector('.note-ghost')).toBeNull();
    stop();
  });

  it('moves nothing with reduced motion asked for', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    const ul = list(['a', 'b', 'c']);
    const { stop } = followLocalChanges(ul);
    writeHere(['a']);
    ul.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    expect(animations).toEqual([]);
    stop();
  });

  /*
   * Autosave writes every few seconds, mostly without changing which rows a list holds.
   * The redraw after it may be a notebook picked or a search typed: those rows did not
   * come or go because of the write, and nothing of them should move.
   */
  it('leaves a redraw alone when rows came or went that the write did not touch', async () => {
    const ul = list(['a', 'b', 'c', 'd']);
    const { stop } = followLocalChanges(ul);
    writeHere(['a'], false);
    ul.querySelector('[data-note-id="c"]')!.remove();
    ul.appendChild(row('other'));
    await flush();
    expect(animations).toEqual([]);
    expect(ul.querySelector('.note-ghost')).toBeNull();
    stop();
  });

  it('lets go of a waiting measurement when told to — a new filter, sort or search', async () => {
    const ul = list(['a', 'b', 'c']);
    const { stop, disarm } = followLocalChanges(ul);
    writeHere(['b']);
    disarm();
    ul.querySelector('[data-note-id="b"]')!.remove();
    await flush();
    expect(animations).toEqual([]);
    stop();
  });

  it('does not measure a list that is not drawn, or one the write cannot change', async () => {
    const hidden = list(['a', 'b']);
    hidden.getClientRects = () => [] as unknown as DOMRectList;
    const one = followLocalChanges(hidden);
    writeHere(['a']);
    hidden.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    one.stop();

    const shown = list(['a', 'b']);
    const two = followLocalChanges(shown);
    writeHere(['elsewhere'], false);
    shown.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    two.stop();
    expect(animations).toEqual([]);
  });

  it('slides the rows after the notes with them, and fades in the empty line without taking it for a stranger', async () => {
    const ul = list(['a', 'b']);
    ul.appendChild(trailing('more'));
    const { stop } = followLocalChanges(ul);
    writeHere(['a']);
    ul.querySelector('[data-note-id="a"]')!.remove();
    await flush();
    expect(moved('more')).toEqual([{ translate: `0 ${ROW}px` }]);

    writeHere(['b']);
    ul.querySelector('[data-note-id="b"]')!.remove();
    ul.querySelector('[data-motion-key="more"]')!.remove();
    ul.appendChild(trailing('empty'));
    await flush();
    expect(moved('empty')).toEqual([{ opacity: 0 }]);
    // A copy for the note that left, none for Load more going with it.
    const copies = [...ul.querySelectorAll('.note-ghost')].map((g) => g.textContent);
    expect(copies).toContain('b');
    expect(copies).not.toContain('more');
    stop();
  });

  it('stops listening when let go', () => {
    const ul = list(['a']);
    followLocalChanges(ul).stop();
    expect(listener).toBeUndefined();
    expect(onLocalWrite).toHaveBeenCalled();
  });
});
