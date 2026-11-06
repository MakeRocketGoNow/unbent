import { describe, it, expect, afterEach, vi } from 'vitest';
import { PAGE, READY, bookmarkletFor, isPageUrl, readPage } from './bookmarklet.js';

/**
 * The bookmarklet runs on someone else's page and `/clip` takes what it is sent from
 * whoever opened it, so both halves are pinned: what the bookmarklet sends and to whom,
 * and what the page accepts.
 */
const ORIGIN = 'https://notes.example.com';

describe('the bookmarklet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (window as { __unbentClip?: unknown }).__unbentClip;
  });

  /** Runs it here, as a click on the bookmark would, with the pop-up and its messages faked. */
  function press() {
    const popup = { postMessage: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const listen = vi.spyOn(window, 'addEventListener');
    new Function(bookmarkletFor(ORIGIN).slice('javascript:'.length))();
    const handler = listen.mock.calls.find((call) => (call[0] as string) === 'message')![1] as (e: Partial<MessageEvent>) => void;
    return { popup, open, handler };
  }

  it('opens /clip on its instance with the address of the page', () => {
    const { open } = press();
    expect(open).toHaveBeenCalledWith(`${ORIGIN}/clip?url=${encodeURIComponent(location.href)}`, 'unbent-clip', expect.any(String));
  });

  it('sends the page, without its scripts and styles, to its own instance only once it is asked', () => {
    document.title = 'An article';
    document.body.innerHTML = '<p>Kept</p><script>secret()</script><style>p{}</style><noscript>x</noscript>';
    const { popup, handler } = press();
    handler({ source: popup as unknown as Window, origin: ORIGIN, data: { type: READY } });
    expect(popup.postMessage).toHaveBeenCalledOnce();
    const [sent, target] = popup.postMessage.mock.calls[0]!;
    expect(target).toBe(ORIGIN);
    expect(sent).toMatchObject({ type: PAGE, url: location.href, title: 'An article' });
    expect(sent.html).toContain('<p>Kept</p>');
    expect(sent.html).not.toMatch(/<script|<style|<noscript/);
    // The page itself is untouched: the person is still reading it.
    expect(document.body.innerHTML).toContain('<script>');
  });

  it('sends nothing to another window or another origin', () => {
    const { popup, handler } = press();
    handler({ source: window, origin: ORIGIN, data: { type: READY } });
    handler({ source: popup as unknown as Window, origin: 'https://elsewhere.example', data: { type: READY } });
    handler({ source: popup as unknown as Window, origin: ORIGIN, data: { type: 'something-else' } });
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  /* A second press reopens the same window, which would otherwise be sent the page twice. */
  it('keeps one listener when pressed again before the window asks', () => {
    const first = press().handler;
    const remove = vi.spyOn(window, 'removeEventListener');
    press();
    expect(remove).toHaveBeenCalledWith('message', first);
  });

  it('says so when the pop-up is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    new Function(bookmarkletFor(ORIGIN).slice('javascript:'.length))();
    expect(alert).toHaveBeenCalledOnce();
  });
});

describe('what /clip accepts', () => {
  it('takes a page with a web address and some HTML', () => {
    expect(readPage({ type: PAGE, url: 'https://example.com/a', title: ' A ', html: '<p>x</p>' })).toEqual({
      url: 'https://example.com/a',
      title: 'A',
      html: '<p>x</p>',
    });
    expect(readPage({ type: PAGE, url: 'http://intranet.local/', html: '<p>x</p>' })?.title).toBe('');
  });

  it('refuses anything else', () => {
    expect(readPage(null)).toBeNull();
    expect(readPage('a page')).toBeNull();
    expect(readPage({ type: READY, url: 'https://example.com/', html: '<p>x</p>' })).toBeNull();
    expect(readPage({ type: PAGE, url: 'javascript:alert(1)', html: '<p>x</p>' })).toBeNull();
    expect(readPage({ type: PAGE, url: 'https://example.com/', html: '' })).toBeNull();
    expect(readPage({ type: PAGE, url: 'https://example.com/', html: 3 })).toBeNull();
    expect(isPageUrl('ftp://example.com/')).toBe(false);
  });
});
