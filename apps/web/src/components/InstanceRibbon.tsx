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
 * Production and local draw none; see `ribbonOf`.
 */
export function InstanceRibbon() {
  const config = useQuery(configQuery());
  const ribbon = ribbonOf(config.data);
  if (!ribbon) return null;
  return (
    <div className={`instance-ribbon instance-${ribbon.kind}`} aria-hidden="true">
      <span>{ribbon.text}</span>
    </div>
  );
}
