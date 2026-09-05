/**
 * The DOM measurement APIs jsdom leaves off Range.
 *
 * jsdom performs no layout, so it implements `getClientRects` and `getBoundingClientRect`
 * on Element — returning an empty list and an all-zero rect — and implements neither of
 * them on Range. CodeMirror needs them there: `measureTextSize` appends a dummy `.cm-line`,
 * takes its text node, and asks `textRange(node, 0, len).getClientRects()` how wide a
 * character is. In a browser that answers; here it threw
 * `TypeError: textRange(...).getClientRects is not a function`.
 *
 * That throw never failed a test, which is what made it worth chasing rather than muting.
 * It fires inside an animation-frame callback rather than any test's promise chain, so
 * Vitest counted it as an unhandled error and exited non-zero while printing a full count
 * of passes — about the least believable result a suite can hand you.
 *
 * It was also intermittent, and the reason is a race rather than a leaked view. An
 * EditorView schedules its measure through requestAnimationFrame, jsdom drives that off a
 * `setInterval(…, 1000 / 60)`, and `view.destroy()` cancels the frame it has pending. A
 * test that finishes inside those ~17ms tears the view down first and never sees this; one
 * that awaits something slower gets the callback while the view is still alive. Which test
 * loses the race is down to machine load — it reproduced roughly one run in four with
 * every core saturated and not once in 25 runs on an idle machine, landing on a different
 * test each time it did. So the stub belongs here rather than in `attach.test.ts`: six
 * test files construct an EditorView, and timing alone decides which is holding the ball.
 *
 * The stubs return exactly what jsdom already returns for Element — an empty rect list and
 * a zero rect — rather than fabricated geometry. CodeMirror has a documented fallback for
 * getting nothing back (a `charWidth` of 7), so an empty list keeps it on its own
 * no-measurement path, which is the truth of the situation. Inventing plausible widths
 * would be worse than useless: layout assertions would start passing for reasons that have
 * nothing to do with a browser.
 *
 * Guarded rather than assigned outright, so a future jsdom that implements these wins.
 */

/**
 * A fresh list per call, not one shared instance.
 *
 * jsdom returns a plain array from `Element.getClientRects()` and the DOM types promise a
 * `DOMRectList`, so the cast records that gap rather than pretending to close it. Handing
 * out the same array to every caller would be the cheaper spelling and a standing invitation
 * for one caller's push to become another's phantom rect; nothing here is hot enough to pay
 * for that.
 */
const emptyRectList = () => [] as unknown as DOMRectList;

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = emptyRectList;
}

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
