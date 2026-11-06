import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { MAX_CLIP_HTML_CHARS } from '@unbent/shared';
import { configQuery } from '../queries.js';
import { useAppSession } from '../useAppSession.js';
import * as actions from '../store/actions.js';
import { CLIP_PATH, READY, readPage, type ClippedPage } from '../bookmarklet.js';
import { whatWentWrong } from './ClipLinkForm.js';
import { Button } from './Button.js';

/**
 * How long `/clip` waits to hear the page from the tab before it settles for the address.
 * Long enough for a heavy page to be copied and posted on a slow laptop, short enough that
 * someone on a site that cut the opener is not left looking at "Reading the page…".
 */
export const PAGE_WAIT_MS = 4000;

/** How often `READY` is said again while waiting: the opener may not be listening yet. */
const READY_EVERY_MS = 500;

type Heard =
  /** Still waiting for the tab. */
  | { kind: 'waiting' }
  /** The tab sent the page. */
  | { kind: 'page'; page: ClippedPage }
  /** Nothing came: no opener, or one that never answered. */
  | { kind: 'silent' };

/**
 * The page from the tab that opened this window, once `ready` says this window can use
 * it. Only a message whose source is `window.opener` counts: any site can post to a
 * window, and only the opener is the page the person pressed the bookmarklet on. A page
 * that arrives after the wait has given up is still taken, since the person has not
 * saved yet and the page is the better clip.
 */
function useOpenerPage(ready: boolean): Heard {
  const [heard, setHeard] = useState<Heard>({ kind: 'waiting' });
  useEffect(() => {
    if (!ready) return;
    const opener = window.opener as Window | null;
    if (!opener) {
      setHeard({ kind: 'silent' });
      return;
    }
    const say = () => {
      try {
        opener.postMessage({ type: READY }, '*');
      } catch {
        // An opener that has gone away; the wait below settles it.
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const page = readPage(event.data);
      if (!page) return;
      stop();
      setHeard({ kind: 'page', page });
    };
    const every = setInterval(say, READY_EVERY_MS);
    const give = setTimeout(() => {
      clearInterval(every);
      setHeard((now) => (now.kind === 'waiting' ? { kind: 'silent' } : now));
    }, PAGE_WAIT_MS);
    const stop = () => {
      clearInterval(every);
      clearTimeout(give);
      window.removeEventListener('message', onMessage);
    };
    window.addEventListener('message', onMessage);
    say();
    return stop;
  }, [ready]);
  return heard;
}

/** The host a person recognises a site by: no `www.`, no port games. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** What the page calls itself, read from its HTML when the tab did not say. */
function titleIn(html: string): string {
  try {
    return new DOMParser().parseFromString(html, 'text/html').title.trim();
  } catch {
    return '';
  }
}

function megabytes(chars: number): string {
  return `${Math.round((chars / (1024 * 1024)) * 10) / 10} MB`;
}

type Saving = { kind: 'idle' } | { kind: 'busy' } | { kind: 'saved'; id: string; title: string } | { kind: 'failed'; error: string };

/**
 * `/clip`: the window the bookmarklet opens, which keeps the page it was opened from.
 *
 * Its own small page in the plain shell rather than a route in the app, because it opens
 * as a pop-up beside someone's reading: the rail, the list and a note would be a whole
 * app squeezed into 480 pixels to show one button. It reads the session itself (the
 * plain shell does not ask for one) so a person who is signed out is told what to do
 * rather than sent to a sign-in screen that would lose the page on the way: the page is
 * in a message to this window, and there is nowhere it could wait across a sign-in.
 *
 * Nothing is saved without a press of Save, which names the page and its site first.
 * That press is the guard against a site opening this window and posting it a page of
 * its choosing (see `bookmarklet.ts`). Saved, it says so and offers the note, rather
 * than opening the app in the pop-up: a clip is something kept while reading, and the
 * reading is in the other window. "Open note" is there for the time it is not.
 *
 * Its states, in order: waiting for the tab, then the page (or the address alone when
 * the tab never answered or the page is past what a request may carry), then saving,
 * then saved or the reason it was not. A refusal links the page, so a site the server
 * could not read is still one click from being kept some other way.
 */
export function ClipPage({ url: addressed }: { url: string | undefined }) {
  const config = useQuery(configQuery());
  const { session, isPending } = useAppSession();
  const offered = config.data?.webClip === true;
  const heard = useOpenerPage(offered && session !== null && !isPending);
  const [saving, setSaving] = useState<Saving>({ kind: 'idle' });
  // One id for this window's clip, so a second press after a lost answer finds the note
  // the first one made rather than clipping the page again.
  const id = useRef<string | null>(null);

  if (config.isPending || isPending) {
    return (
      <div className="login clip-page">
        <h1>Unbent</h1>
        <p className="muted small">One moment…</p>
      </div>
    );
  }

  if (!offered) {
    return (
      <div className="login clip-page">
        <h1>Unbent</h1>
        <p>This Unbent doesn&apos;t clip web pages.</p>
        <p className="muted small">Its operator hasn&apos;t switched clipping on.</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login clip-page">
        <h1>Unbent</h1>
        <p>Sign in to clip this page.</p>
        <p className="muted small">Then press the Clip to Unbent bookmark on the page again.</p>
        <div className="login-actions">
          {/* The way to another page, so a link wearing the button's shape. Back to a bare
              /clip after, which has nothing to keep and says so. */}
          <Link to="/login" search={{ redirect: CLIP_PATH }} className="btn btn-primary">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const page = heard.kind === 'page' ? heard.page : null;
  const url = page?.url ?? addressed;
  const tooLarge = page !== null && page.html.length > MAX_CLIP_HTML_CHARS;
  // The page from the tab when there is one that fits; otherwise the server reads the
  // address, as "Clip a link" does.
  const html = page && !tooLarge ? page.html : undefined;

  if (!url) {
    if (heard.kind === 'waiting') return <Waiting />;
    return (
      <div className="login clip-page">
        <h1>Unbent</h1>
        <p>Nothing to clip here.</p>
        <p className="muted small">
          Press the Clip to Unbent bookmark on the page you want to keep. It is in{' '}
          <Link to="/settings/import">Settings, Import</Link> if it isn&apos;t in your bookmarks yet.
        </p>
      </div>
    );
  }

  if (heard.kind === 'waiting' && saving.kind === 'idle') return <Waiting />;

  const host = hostOf(url);
  const title = (page && (page.title || titleIn(page.html))) || host;

  async function save() {
    if (!url || saving.kind === 'busy') return;
    setSaving({ kind: 'busy' });
    try {
      id.current ??= crypto.randomUUID();
      const note = await actions.clipLink({ id: id.current, url, ...(html ? { html } : {}) });
      setSaving({ kind: 'saved', id: note.id, title: note.title });
    } catch (err) {
      setSaving({ kind: 'failed', error: whatWentWrong(err) });
    }
  }

  if (saving.kind === 'saved') {
    // A window the bookmarklet opened can close itself; a /clip someone typed into a tab
    // cannot, and a Close that does nothing is worse than none.
    const closable = window.opener !== null || window.history.length === 1;
    const href = `/notes/${encodeURIComponent(saving.id)}`;
    return (
      <div className="login clip-page">
        <h1>Saved</h1>
        <p className="clip-page-title">{saving.title || title}</p>
        <div className="login-actions">
          {closable && (
            <Button variant="primary" size="large" onClick={() => window.close()}>
              Close
            </Button>
          )}
          {closable ? (
            // A plain link, not the router's: see `openInTab`.
            <a href={href} className="btn btn-secondary" onClick={openInTab}>
              Open note
            </a>
          ) : (
            <Link to="/notes/$noteId" params={{ noteId: saving.id }} className="btn btn-primary">
              Open note
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="login clip-page">
      <h1>Clip to Unbent</h1>
      <p className="clip-page-title">{title}</p>
      {/* Not twice: with no page from the tab, its host is all the title there is. */}
      {title !== host && <p className="muted small clip-page-host">{host}</p>}
      {!html && (
        <p className="muted small clip-page-how" role="note">
          {tooLarge
            ? `This page is too large to send from its tab (${megabytes(page.html.length)}; the most is ${megabytes(MAX_CLIP_HTML_CHARS)}). Unbent will fetch it from ${host} instead, as someone who isn't signed in there would see it.`
            : `The page didn't answer from its tab, so Unbent will fetch it from ${host} instead, as someone who isn't signed in there would see it.`}
        </p>
      )}
      <div className="login-actions">
        <Button variant="primary" size="large" disabled={saving.kind === 'busy'} aria-busy={saving.kind === 'busy' || undefined} onClick={() => void save()}>
          {saving.kind === 'busy' ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {saving.kind === 'failed' && (
        <p className="bad small clip-page-error" role="alert">
          {saving.error}{' '}
          {/* The page, a click away: a clip the server refused can still be kept by hand. */}
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open the page
          </a>
        </p>
      )}
    </div>
  );
}

/**
 * "Open note" from the pop-up: the note in a tab of its own, and the pop-up closed.
 *
 * The router's link moved this window from `/clip` to the note, which put the whole app
 * in a 480-pixel pop-up, and on 2026-11-06 it drew wrong there: the frame came out taller
 * than the window, so the document scrolled and the note's own scroller had nothing to
 * scroll (its `overscroll-behavior: contain` swallowed the wheel), leaving the scrollbar
 * as the only way down. A fresh load of the same note in the same pop-up drew fine, and it
 * has not been seen since, so the cause is a guess (the note drawn inside the plain
 * shell's frame on a route change). It does not matter which: the pop-up is for Save or
 * not, and a note belongs in a tab. Chrome puts the new tab in the browser window used
 * last, which is the one the person was reading in.
 *
 * A modified click (a middle click, Cmd or Ctrl, Shift, Alt) is left to the browser, which
 * opens the link as asked and keeps this window. A new tab the browser refuses is a full
 * load of the note here, not a route change, so it draws as a page of its own would.
 */
function openInTab(event: React.MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const href = event.currentTarget.getAttribute('href')!;
  const tab = window.open(href, '_blank');
  if (!tab) {
    window.location.assign(href);
    return;
  }
  // The note's tab has no business with this window, and this window is about to go.
  tab.opener = null;
  window.close();
}

function Waiting() {
  return (
    <div className="login clip-page">
      <h1>Clip to Unbent</h1>
      <p className="muted small" role="status">
        Reading the page…
      </p>
    </div>
  );
}
