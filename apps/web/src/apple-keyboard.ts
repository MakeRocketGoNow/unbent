/**
 * Whether this device spells "the platform modifier" ⌘ (and Alt ⌥, Shift ⇧) rather than
 * Ctrl: macOS and iOS. CodeMirror's `Mod` follows the same split.
 *
 * One check for the editor's link hint and the help page's keys, so the two cannot come to
 * disagree about which keys a Mac shows. A function rather than a constant so a test can
 * stub `navigator` and ask again.
 */
export function isAppleKeyboard(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}
