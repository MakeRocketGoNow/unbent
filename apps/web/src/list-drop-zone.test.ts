import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropSentence, listDropZone } from './list-drop-zone.js';

/**
 * The list as a drop target: which drags it claims, what it says over them, and what a
 * drop hands on. What the files become is `file-notes.ts`'s, tested beside it.
 */

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.replaceChildren();
});

function mount(accept: (count: number) => string | null = (n) => dropSentence(n, 'Receipts')) {
  const zone = document.createElement('aside');
  const row = document.createElement('li');
  zone.appendChild(row);
  document.body.appendChild(zone);
  const onHover = vi.fn();
  const onFiles = vi.fn();
  cleanup = listDropZone(zone, { accept, onHover, onFiles });
  return { zone, row, onHover, onFiles };
}

/** A drag event; jsdom has neither DragEvent nor DataTransfer, so the transfer is a plain object. */
function dragEvent(type: string, { types = ['Files'], files = 2, target = null as Node | null, relatedTarget = null as Node | null } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = Array.from({ length: types.includes('Files') ? files : 0 }, (_, i) => new File(['%PDF'], `scan ${i + 1}.pdf`, { type: 'application/pdf' }));
  const transfer = {
    types,
    // During a dragover the browser lists the items but withholds the files.
    items: type === 'drop' ? [] : list.map(() => ({ kind: 'file' })),
    files: type === 'drop' ? list : [],
    dropEffect: 'copy',
  };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  (target ?? document.body).dispatchEvent(event);
  return { event, transfer };
}

describe('listDropZone', () => {
  it('claims a drag carrying files and says what a drop will do', () => {
    const { zone, onHover } = mount();
    const { event, transfer } = dragEvent('dragover', { target: zone });
    expect(event.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    expect(onHover).toHaveBeenCalledWith('Drop to add 2 notes to Receipts');
  });

  it('leaves dragged text to the browser', () => {
    const { zone, onHover } = mount();
    const { event } = dragEvent('dragover', { types: ['text/plain'], target: zone });
    expect(event.defaultPrevented).toBe(false);
    expect(onHover).not.toHaveBeenCalled();
  });

  it('refuses with the pointer when the target says no, and the drop does nothing', () => {
    const { zone, onHover, onFiles } = mount(() => null);
    const { event, transfer } = dragEvent('dragover', { target: zone });
    // Still claimed, or the browser would open the file in place of the app.
    expect(event.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('none');
    expect(onHover).toHaveBeenCalledWith(null);
    dragEvent('drop', { target: zone });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('clears the sentence on leaving the column, not on crossing into a row of it', () => {
    const { zone, row, onHover } = mount();
    dragEvent('dragover', { target: zone });
    dragEvent('dragleave', { target: zone, relatedTarget: row });
    expect(onHover).not.toHaveBeenCalledWith(null);
    dragEvent('dragleave', { target: zone, relatedTarget: document.body });
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('hands the dropped files on, in order, and clears the sentence', () => {
    const { zone, onHover, onFiles } = mount();
    const { event } = dragEvent('drop', { target: zone, files: 3 });
    expect(event.defaultPrevented).toBe(true);
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['scan 1.pdf', 'scan 2.pdf', 'scan 3.pdf']);
  });

  it('leaves a drag something inside the column already claimed', () => {
    const { zone, row, onHover } = mount();
    row.addEventListener('dragover', (e) => e.preventDefault());
    dragEvent('dragover', { target: row });
    expect(onHover).not.toHaveBeenCalled();
  });
});

describe('dropSentence', () => {
  it('counts the files and names the place, when there is one', () => {
    expect(dropSentence(12, 'Receipts')).toBe('Drop to add 12 notes to Receipts');
    expect(dropSentence(1, 'Receipts')).toBe('Drop to add a note to Receipts');
    expect(dropSentence(12, null)).toBe('Drop to add 12 notes');
  });

  it('does without a count when the browser withholds one', () => {
    expect(dropSentence(0, 'Receipts')).toBe('Drop to add notes to Receipts');
    expect(dropSentence(0, null)).toBe('Drop to add notes');
  });
});
