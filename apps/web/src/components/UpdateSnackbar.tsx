import { useUpdateNotice } from '../sw-register.js';
import { Snackbar } from './Snackbar.js';

/**
 * Says the build now in charge is one this page cannot keep running beside, and that it
 * needs a reload.
 *
 * A deploy's worker takes charge the moment it has installed, and a page in use keeps
 * running its own build on top of it (see `sw-register.ts`). Nothing reloads that page
 * on its own: a reload resets a list someone is three hundred rows into, and every rule
 * that tried to pick a harmless moment for it picked a wrong one for somebody. So this is
 * the word, with the reload one press away. It shows only when the deploy raised the
 * compatibility level (`compat/level.ts`), which is rare: it used to show for every
 * deploy, and the people trying the app were asked to reload after every merge for
 * nothing. "Needs", not "is ready": the word is said only when it is true.
 *
 * It stays until it is answered, and has no timer: a notice that cleared itself would put
 * back exactly the doubt it exists to remove. Info, not error: nothing is wrong, and the
 * old build keeps working. Dismissing it changes nothing but the notice; the next load,
 * whenever it comes, is the newest build. Rendered once in the shell, beside the other
 * snackbars.
 */
export function UpdateSnackbar() {
  const { shown, reload, dismiss } = useUpdateNotice();
  if (!shown) return null;
  return (
    <Snackbar
      message="A new version of Unbent needs a reload."
      tone="info"
      action={{ label: 'Reload', onClick: reload }}
      onDismiss={dismiss}
    />
  );
}
