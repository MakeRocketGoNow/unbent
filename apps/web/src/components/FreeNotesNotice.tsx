import { useEffect, useState } from 'react';
import { FREE_NOTES } from '@unbent/shared';
import { isHosted } from '../app-bridge.js';
import { offlineNow } from '../connectivity.js';
import { onFreeNotesFull } from '../free-notes.js';
import { Snackbar } from './Snackbar.js';

/**
 * Says that the free plan holds its hundred notes, when a press that would have made a
 * note is refused on the device for it (`showFreeNotesFull`): New, the phone's +, the
 * empty state, the apps' New note shortcut, Duplicate. Mounted once, by the notes view,
 * where every one of those is.
 *
 * Short, as a snackbar is: the count, counting the trash, and the two ways out; the Plan
 * page has the rest beside its meters. Not an error's red, since nothing failed. Inside
 * the apps the way to the plan is the web, as the banner says it (`PlanBanner`), and no
 * link leads to a page whose buttons are not drawn there.
 *
 * Offline it says the answer is this device's last read of the plan. Online the press
 * read the plan again before it was refused (`roomForNotes`), so the refusal is the
 * server's; offline nothing can be asked, and someone who subscribed on another device
 * since was told to subscribe. Rather than letting the note through after a while: if
 * the account is still free, the server refuses it, and the kept create then holds back
 * every save behind it.
 */
export function FreeNotesNotice() {
  const [shown, setShown] = useState<'online' | 'offline' | null>(null);
  useEffect(() => onFreeNotesFull(() => setShown(offlineNow() ? 'offline' : 'online')), []);
  if (!shown) return null;
  const hosted = isHosted();
  const asRead = shown === 'offline' ? ', as this device last read your plan' : '';
  return (
    <Snackbar
      message={`The free plan holds ${FREE_NOTES} notes, counting the trash${asRead}. Delete some and empty the trash, or subscribe${hosted ? ' on the web' : ''} for unlimited notes.`}
      tone="info"
      link={hosted ? undefined : { label: 'Plan', to: '/settings/plan' }}
      duration={10_000}
      onDismiss={() => setShown(null)}
    />
  );
}
