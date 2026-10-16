import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { resetConnectivity, setReachableForTests } from '../connectivity.js';
import { Preview } from './Preview.js';

// A PDF link splits the pane into segments, which is what lets one segment's HTML stay
// the same string (and so the same DOM) while another is edited.
vi.mock('../usePdfAttachments.js', () => ({ usePdfAttachments: () => new Set(['doc.pdf']) }));
vi.mock('./PdfPreview.js', () => ({ PdfPreview: () => null }));

const note = (tail: string) => `![photo](files/photo.jpg)\n\n[doc](files/doc.pdf)\n\n${tail}`;

beforeEach(() => resetConnectivity());
afterEach(() => {
  cleanup();
  resetConnectivity();
});

describe('a picture in the preview pane with no connection', () => {
  it('says so in a line, and comes back with the connection even after the note was edited elsewhere', () => {
    const { container, rerender } = render(<Preview markdown={note('first')} noteId="n1" />);
    const img = container.querySelector('img')!;
    setReachableForTests(false);
    fireEvent.error(img);
    expect(container.querySelector('.file-unavailable')?.textContent).toBe('photo · Not available offline');

    // Typing below the PDF: the picture's own segment is the same string, so React keeps
    // its DOM, the stand-in with it, and the wait for the connection has to be kept too.
    rerender(<Preview markdown={note('second')} noteId="n1" />);
    expect(container.querySelector('img')).toBe(img);
    expect(container.querySelector('.file-unavailable')).not.toBeNull();

    setReachableForTests(true);
    expect(container.querySelector('.file-unavailable')).toBeNull();
    expect(img.hidden).toBe(false);
  });

  it('stops waiting once the picture is gone', () => {
    const { container, rerender, unmount } = render(<Preview markdown={note('first')} noteId="n1" />);
    setReachableForTests(false);
    const img = container.querySelector('img')!;
    fireEvent.error(img);
    // The picture's own segment changes, so its DOM is replaced; then the pane goes.
    rerender(<Preview markdown={`intro\n\n${note('first')}`} noteId="n1" />);
    expect(img.isConnected).toBe(false);
    unmount();
    // Nothing is left listening: the connection returning touches no detached picture.
    setReachableForTests(true);
    expect(img.hidden).toBe(true);
  });
});

/**
 * A link to a page of this app goes through the router, as it does in the rich editor,
 * not a navigation that would load the whole app again. In this file because it is the
 * pane's only test file; nothing here is about the connection.
 */
describe('a link to a page of this app in the preview pane', () => {
  it('opens in place', () => {
    const openPath = vi.fn(() => true);
    const { container } = render(<Preview markdown="[Import](/settings/import)" noteId="n1" onOpenPath={openPath} />);
    const link = container.querySelector('a[href="/settings/import"]')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(openPath).toHaveBeenCalledWith('/settings/import');
    expect(click.defaultPrevented).toBe(true);
  });

  it('leaves a modified click, and a path the app refuses, to the browser', () => {
    const openPath = vi.fn(() => false);
    const { container } = render(<Preview markdown="[Import](/settings/import)" noteId="n1" onOpenPath={openPath} />);
    const link = container.querySelector('a[href="/settings/import"]')!;
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    link.dispatchEvent(modified);
    expect(openPath).not.toHaveBeenCalled();
    const refused = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(refused);
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(refused.defaultPrevented).toBe(false);
  });
});
