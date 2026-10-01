import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { ribbonOf } from '../instance-marker.js';

/**
 * A corner ribbon on the drawer and the rail — "Dev", or the PR a preview is of — so a
 * scratch instance is plain at a glance and not only from its tab.
 *
 * In the navigation's corner rather than the page's: that corner is empty at both widths,
 * where the page's own top-left is the menu button on a phone. It takes no height and
 * moves nothing, which is what lets a preview still be the place a PR's layout is judged.
 * The pointer goes through it, and assistive tech skips it; the tab title and the account
 * menu say the same in words.
 *
 * `page` is the same ribbon pinned to the screen's own corner, for the phone, where the
 * drawer is closed most of the time, and for the sign-in screen, which has no navigation
 * at all. At phone width that corner holds the menu or back button, so it is the compact
 * size: it ends 37px along the diagonal and the button's glyph begins at 39, so it sits
 * beside the glyph rather than over it, and the pointer goes through to the button.
 *
 * Production and local draw none; see `ribbonOf`.
 */
export function InstanceRibbon({ placement }: { placement: 'rail' | 'drawer' | 'page' }) {
  const config = useQuery(configQuery());
  const ribbon = ribbonOf(config.data);
  if (!ribbon) return null;
  // Only the drawer's band is long enough for the whole label; see `ribbonOf`.
  const text = placement === 'drawer' ? ribbon.text : ribbon.short;
  return (
    <div
      className={`instance-ribbon instance-${ribbon.kind}${placement === 'page' ? ' instance-ribbon-page' : ''}`}
      aria-hidden="true"
    >
      <span>{text}</span>
    </div>
  );
}
