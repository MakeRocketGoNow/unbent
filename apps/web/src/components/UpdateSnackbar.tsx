import { useUpdateNotice } from '../sw-register.js';
import { Snackbar } from './Snackbar.js';

/**
 * Says a new version of the app is ready, while the page is in use.
 *
 * A deploy found during a fresh load is taken at once, and one found later waits for a
 * moment a reload costs nothing — see `sw-register.ts`. Those moments can be a long time
 * coming for someone who stays in one place, and until now the wait was silent: the old
 * build went on looking current, and a reload did not change it. This is the word that
 * was missing, with the reload one press away. Dev and previews take a deploy whenever it
 * arrives (`takesDeploysAtOnce`), so there it shows only for one that cannot be taken yet:
 * held back by the page for more than a few seconds — an import, say — where the deploy
 * still follows by itself once the page lets go, turned away by the minute's guard, or
 * found on an embed page.
 *
 * It stays until it is answered, and has no timer: a notice that cleared itself would put
 * back exactly the doubt it exists to remove. Info, not error — nothing is wrong, and the
 * old build keeps working. Dismissing it does not cancel the update; the automatic
 * moments still take it. Rendered once in the shell, beside the other snackbars.
 */
export function UpdateSnackbar() {
  const { shown, reload, dismiss } = useUpdateNotice();
  if (!shown) return null;
  return (
    <Snackbar
      message="A new version of Unbent is ready."
      tone="info"
      action={{ label: 'Reload', onClick: reload }}
      onDismiss={dismiss}
    />
  );
}
