import { useEffect, useState } from 'react';
import { FREE_NOTES } from '@unbent/shared';
import { isHosted } from '../app-bridge.js';
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
 */
export function FreeNotesNotice() {
  const [shown, setShown] = useState(false);
  useEffect(() => onFreeNotesFull(() => setShown(true)), []);
  if (!shown) return null;
  const hosted = isHosted();
  return (
    <Snackbar
      message={`The free plan holds ${FREE_NOTES} notes, counting the trash. Delete some and empty the trash, or subscribe${hosted ? ' on the web' : ''} for unlimited notes.`}
      tone="info"
      link={hosted ? undefined : { label: 'Plan', to: '/settings/plan' }}
      duration={10_000}
      onDismiss={() => setShown(false)}
    />
  );
}
