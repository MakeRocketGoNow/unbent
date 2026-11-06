/**
 * The bookmarklet that clips the page a person is looking at, and the two messages it
 * trades with `/clip`.
 *
 * Why a bookmarklet and a page rather than a request from the bookmarklet itself: the
 * bookmarklet runs inside someone else's site, where a request to this instance would be
 * a cross-origin call carrying the session cookie, which is exactly what the cookie's
 * rules and every site's own policy exist to stop. A window this instance opens is
 * first-party, signed in, and draws its own Save button, and that press is the guard: any
 * site can open `/clip` and post it a page, and nothing is filed until the person who
 * owns the account presses Save on a page that names what it is about to keep.
 *
 * The handshake, in order:
 * 1. The bookmarklet opens `<instance>/clip?url=<the page's address>`.
 * 2. `/clip`, once it knows it can save, posts `READY` to `window.opener` with target `*`.
 *    It carries nothing, so the target does not matter; the opener's origin is not one
 *    the page can know before it hears from it.
 * 3. The bookmarklet waits for `READY` from the window it opened, on this instance's
 *    origin, then posts the page to that window with the instance's origin as the target,
 *    so the HTML reaches this instance or nobody.
 * 4. `/clip` takes a `PAGE` only from `window.opener`.
 *
 * A site whose Cross-Origin-Opener-Policy severs the opener (and anything else that stops
 * the messages) leaves `/clip` with only the address, which the server can fetch itself,
 * as "Clip a link" does; the page says so (`ClipPage`).
 */

export const CLIP_PATH = '/clip';

/** `/clip` to the bookmarklet: send the page. */
export const READY = 'unbent-clip-ready';

/** The bookmarklet to `/clip`: the page. */
export const PAGE = 'unbent-clip-page';

/** What the bookmarklet sends: where the page is, what it is called, and the page. */
export interface ClippedPage {
  url: string;
  title: string;
  html: string;
}

/** A web address the server will take as where a page came from. */
export function isPageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A message from the opener, read as the page if it is one, and as nothing otherwise.
 * The source is checked by the caller (`event.source === window.opener`); this checks the
 * shape, since the opener is a site that can post whatever it likes.
 */
export function readPage(data: unknown): ClippedPage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, url, title, html } = data as Record<string, unknown>;
  if (type !== PAGE || !isPageUrl(url) || typeof html !== 'string' || html === '') return null;
  return { url, title: typeof title === 'string' ? title.trim().slice(0, 500) : '', html };
}

/**
 * The bookmarklet's source, for an instance at `origin`.
 *
 * Plain ES5 in one expression, since it runs on whatever site the person is reading, in
 * whatever browser they have, and a bookmark holds one line. Scripts, styles and
 * `noscript` are taken out of a copy of the page before it is sent: the server drops them
 * before reading anyway, and they are most of a modern page's weight, so a page that
 * would pass the size cap only without them is not refused for them. The copy, not the
 * page: the person is still reading it.
 *
 * A blocked pop-up is said in an alert, since there is no other place to say it on
 * someone else's page.
 */
export function bookmarkletFor(origin: string): string {
  const o = JSON.stringify(origin);
  const body = [
    `var o=${o},u=location.href;`,
    `var w=window.open(o+${JSON.stringify(`${CLIP_PATH}?url=`)}+encodeURIComponent(u),"unbent-clip","width=480,height=620");`,
    `if(!w){alert("Allow pop-ups for this site to clip it with Unbent.");return;}`,
    `function h(e){`,
    `if(e.source!==w||e.origin!==o||!e.data||e.data.type!==${JSON.stringify(READY)})return;`,
    `removeEventListener("message",h);`,
    `var d=document.documentElement.cloneNode(true),n=d.querySelectorAll("script,style,noscript"),i;`,
    `for(i=0;i<n.length;i++)n[i].parentNode.removeChild(n[i]);`,
    `w.postMessage({type:${JSON.stringify(PAGE)},url:u,title:document.title,html:d.outerHTML},o);`,
    `}`,
    `addEventListener("message",h);`,
  ].join('');
  return `javascript:(function(){${body}})();void 0`;
}
