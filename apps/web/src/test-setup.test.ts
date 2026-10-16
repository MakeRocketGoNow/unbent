import { describe, expect, it } from 'vitest';

/**
 * Guards the wiring in `vitest.config.ts`, not the DOM.
 *
 * Without `setupFiles` pointing at `test-setup.ts`, CodeMirror's `measureTextSize` throws
 * `TypeError: textRange(...).getClientRects is not a function` from inside an
 * animation-frame callback. That does not fail any test: it surfaces as an unhandled
 * error and a non-zero exit alongside a full count of passes, roughly one run in four with
 * the cores loaded and never on an idle machine. A regression here would be close to
 * invisible, so it is asserted directly and cheaply.
 *
 * Deliberately checks the capability rather than calling `measureTextSize`, which lives on
 * `view.docView` and is not part of CodeMirror's public API: a test reaching in there
 * would break on an upgrade that renamed it, for reasons having nothing to do with this.
 */
describe('test environment', () => {
  it('has the Range measurement APIs CodeMirror needs', () => {
    const range = document.createRange();
    expect(typeof range.getClientRects).toBe('function');
    expect(typeof range.getBoundingClientRect).toBe('function');
  });
});
