import { useUpdateNotice } from '../sw-register.js';
import { Snackbar } from './Snackbar.js';

/**
 * Says the build now in charge is one this page cannot keep running beside, and that a
 * reload is what keeps it working.
 *
 * A deploy's worker takes charge the moment it has installed, and a page in use keeps
 * running its own build on top of it (see `sw-register.ts`). Nothing reloads that page
 * on its own: a reload resets a list someone is three hundred rows into, and every rule
 * that tried to pick a harmless moment for it picked a wrong one for somebody. So this is
 * the word, with the reload one press away. It shows only when the deploy raised the
 * compatibility level (`COMPAT_LEVEL`), which is rare: it used to show for every
 * deploy, and the people trying the app were asked to reload after every merge for
 * nothing.
 *
 * The words say what the reload is for. "A new version is ready" was right when the
 * notice was news and the old build kept working; now it shows only when this page may
 * not keep working (the server can refuse what it sends), and "needs a reload" read as
 * the new version needing one. Info, not error, all the same: nothing has failed yet, and
 * alarm over something one press fixes would be out of proportion.
 *
 * It stays until it is answered, and has no timer: a notice that cleared itself would put
 * back exactly the doubt it exists to remove. Dismissing it keeps this page on its own
 * build, which the server may refuse, until its next load; it stays dismissed for this
 * deploy (`dismissNotice`). Rendered once in the shell, beside the other snackbars.
 */
export function UpdateSnackbar() {
  const { shown, reload, dismiss } = useUpdateNotice();
  if (!shown) return null;
  return (
    <Snackbar
      message="Unbent was updated. Reload to keep working."
      tone="info"
      action={{ label: 'Reload', onClick: reload }}
      onDismiss={dismiss}
    />
  );
}
