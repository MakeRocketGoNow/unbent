import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refuseStrayFileDrops } from './file-drop-guard.js';

/**
 * A file dropped where nothing takes it is refused rather than opened by the browser in
 * place of the app. What it must not do is take a drag from something that wanted it.
 */

let off: () => void;
beforeEach(() => {
  off = refuseStrayFileDrops();
});
afterEach(() => {
  off();
  document.body.replaceChildren();
});

/** A drag event carrying `types`; jsdom has neither DragEvent nor DataTransfer. */
function dragEvent(type: string, types = ['Files']): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files: [], dropEffect: 'copy' },
    configurable: true,
  });
  return event as DragEvent;
}

function element(tag = 'div'): HTMLElement {
  return document.body.appendChild(document.createElement(tag));
}

describe('refuseStrayFileDrops', () => {
  it('claims and refuses a file over something that does not take it', () => {
    const event = dragEvent('dragover');
    element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.dataTransfer?.dropEffect).toBe('none');
  });

  it('keeps the browser from opening a file let go there', () => {
    const event = dragEvent('drop');
    element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a drag that something below already took', () => {
    const target = element();
    target.addEventListener('dragover', (e) => e.preventDefault());
    const event = dragEvent('dragover');
    target.dispatchEvent(event);
    expect(event.dataTransfer?.dropEffect).toBe('copy');
  });

  it('leaves dragged text to the browser', () => {
    const event = dragEvent('dragover', ['text/plain']);
    element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves a native file input to take the file', () => {
    const input = element('input') as HTMLInputElement;
    input.type = 'file';
    const over = dragEvent('dragover');
    const drop = dragEvent('drop');
    input.dispatchEvent(over);
    input.dispatchEvent(drop);
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
  });
});
