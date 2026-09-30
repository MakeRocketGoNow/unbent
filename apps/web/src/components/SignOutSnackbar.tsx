import { useSignOut, useSignOutFailed } from '../useSignOut.js';
import { Snackbar } from './Snackbar.js';

/**
 * Says a sign-out did not happen, when the server did not confirm it in a browser.
 *
 * The account menu has closed by the time the answer comes back, so without this the press
 * would do nothing at all — the dead control this app keeps removing. An error, so it
 * stays until dismissed; with Try again, because the likeliest cause is a moment's
 * failure. Rendered once in the shell beside the export and import snackbars, which is
 * why the failure lives in a store rather than in the menu that was pressed.
 */
export function SignOutSnackbar() {
  const { failed, dismiss } = useSignOutFailed();
  const signOut = useSignOut();
  if (!failed) return null;
  return (
    <Snackbar
      message="Couldn’t sign out."
      tone="error"
      action={{ label: 'Try again', onClick: signOut }}
      onDismiss={dismiss}
    />
  );
}
