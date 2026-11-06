import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { bookmarkletFor } from '../bookmarklet.js';
import { ClipLinkIcon } from './icons.js';

/**
 * Where the bookmarklet is installed from: a link to drag to the bookmarks bar, built for
 * this instance's origin, so a bookmark made from a self-hosted instance clips into that
 * one. Drawn only where the instance clips (`config.webClip`); elsewhere there is nothing
 * for it to do.
 *
 * A link, not a `Button`: what it is for is being dragged, and only an anchor drags into a
 * bookmarks bar as a bookmark. It is drawn as a chip so it reads as a thing to pick up
 * rather than a place to go, and a click on it here is caught: run on this page it would
 * clip Unbent's own settings, so it says what to do with it instead.
 *
 * The `href` is set on the node, not as a prop: React refuses a `javascript:` URL in
 * `href` (it renders a placeholder that throws), which is right for every other link in
 * the app and is the one thing this link is.
 */
export function ClipBookmarklet() {
  const config = useQuery(configQuery());
  const ref = useRef<HTMLAnchorElement>(null);
  const [pressed, setPressed] = useState(false);
  const offered = config.data?.webClip === true;

  useEffect(() => {
    ref.current?.setAttribute('href', bookmarkletFor(window.location.origin));
  }, [offered]);

  if (!offered) return null;
  return (
    <section className="settings-section">
      <h3>Clip from your browser</h3>
      <p className="muted small">
        Drag this to your bookmarks bar. On any page, press it to keep the page as a note, as you
        see it, signed in to that site or not.
      </p>
      <a
        ref={ref}
        className="bookmarklet-chip"
        draggable
        onClick={(e) => {
          e.preventDefault();
          setPressed(true);
        }}
      >
        <ClipLinkIcon />
        Clip to Unbent
      </a>
      {pressed && (
        <p className="small" role="status">
          Drag it to your bookmarks bar, then press it on the page you want to keep.
        </p>
      )}
    </section>
  );
}
