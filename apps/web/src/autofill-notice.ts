import { rememberedSession } from './session-memory.js';

/**
 * Whether this device has shown this account what Auto-fill does before letting a press
 * through (MAK-225).
 *
 * Auto-fill is the one place a model reads a note, and the button says "Auto-fill" with a
 * sparkle, which names the convention and not the fact: that the press sends the note to
 * a service outside the instance. The privacy policy and Maintenance both say so, but
 * nobody reads either before their first press, so the first press asks instead, in a
 * confirm that says what goes where, and only once.
 *
 * Kept on the device rather than on the account, deliberately. A flag on the server would
 * be a schema change on the user store, a route and a settings surface for one bit, and a
 * disclosure that shows once more on a new browser is arguably right rather than wrong.
 * Keyed on the account all the same, so two people sharing a browser are each told. If a
 * notice per device turns out to be a nuisance it can move to the account later.
 *
 * Read at press time, not at mount, through `rememberedSession` rather than the session
 * hook: the id is wanted once, when the button is pressed, long after the session has
 * answered, and the remembered session is that answer without a fetch of its own. Wrapped
 * like every other read of storage in this app: a browser that refuses it asks every time,
 * which is the honest fallback for a disclosure.
 */
const PREFIX = 'unbent.autofillExplained.';

function key(): string {
  return PREFIX + (rememberedSession()?.user.id ?? 'anonymous');
}

export function autofillExplained(): boolean {
  try {
    return localStorage.getItem(key()) !== null;
  } catch {
    return false;
  }
}

export function markAutofillExplained(): void {
  try {
    localStorage.setItem(key(), new Date().toISOString());
  } catch {
    // Storage refused or full. The notice shows again next press, which is the safe side.
  }
}
