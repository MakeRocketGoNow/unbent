/**
 * The app's tooltips: any element with a `data-tip` shows that text in a bubble beside it
 * when the pointer rests on it or the keyboard focuses it.
 *
 * It replaces `title` on controls, the icon buttons first. A native title waits about a
 * second and a half before it appears, draws in the operating system's style rather than
 * the app's, and once the pointer moves to the next icon in a row it waits all over again
 * — so in a bar of four glyphs, finding the one you want meant resting on each in turn.
 * This one waits `SHOW_DELAY_MS`, and once a bubble has shown, the next one in the same
 * sweep shows at once (`WARM_MS`), the way a desktop toolbar behaves.
 *
 * One listener on the document and one bubble, rather than a `<Tooltip>` wrapped around
 * each control: there are dozens of controls, many of them already inside wrappers whose
 * layout a wrapper element would disturb, and an attribute costs a call site nothing. The
 * bubble is a `popover`, so it is drawn in the top layer — above a modal `<dialog>` like
 * `Sheet`, which a fixed element on the body would sit under.
 *
 * Never on touch. A phone has no hover, a long press already belongs to the system, and a
 * bubble that appeared on a tap would cover what the tap just did. A control whose meaning
 * a phone needs carries it some other way — its name, or a word under it on a tap, as
 * `NotSyncedMark` does.
 *
 * Drawn only, never read out. An icon button still needs its `aria-label`, and a tip that
 * says more than the name — why a control is faded, above all — needs `aria-description`
 * beside it, which `Button`'s `tip` prop writes for both. Tying the description to the
 * bubble was tried: `aria-describedby` set while it showed. A disabled button cannot be
 * focused, so its reason never reached a screen reader at all, where `title` had always
 * carried it.
 *
 * `title` stays where it is the right tool: on text cut short by an ellipsis, which shows
 * its whole self after the usual wait. A fast bubble there would flash over every row a
 * pointer crosses on its way down a list.
 *
 * Returns the cleanup, for tests; the app installs it once and keeps it.
 */
export function installTooltips(doc: Document = document): () => void {
  const view = doc.defaultView ?? window;
  const bubble = doc.createElement('div');
  bubble.className = 'tip';
  bubble.id = 'app-tip';
  // Hidden from the accessibility tree: what it says is on the control already.
  bubble.setAttribute('aria-hidden', 'true');
  // `manual`: nothing but this module opens or closes it. An `auto` popover would close
  // any other open popover — a menu, say — the moment a tip appeared over it.
  bubble.setAttribute('popover', 'manual');
  doc.body.appendChild(bubble);

  let shown: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the last bubble closed, for the warm sweep. */
  let closedAt = -Infinity;
  /** Pressed, so not shown again until the pointer leaves it. */
  let pressed: HTMLElement | null = null;
  let watcher: MutationObserver | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };

  const hide = () => {
    cancel();
    if (!shown) return;
    watcher?.disconnect();
    shown = null;
    closedAt = view.performance.now();
    if (popoverOpen(bubble)) bubble.hidePopover();
    bubble.removeAttribute('data-open');
  };

  const show = (el: HTMLElement) => {
    cancel();
    const text = el.dataset.tip?.trim();
    if (!text || !el.isConnected) return hide();
    if (shown !== el) {
      hide();
      shown = el;
      // The text can change while it shows — Copy becoming Copied — and the bubble follows.
      watcher = new MutationObserver(() => (el.dataset.tip ? show(el) : hide()));
      watcher.observe(el, { attributes: true, attributeFilter: ['data-tip'] });
    }
    bubble.textContent = text;
    // Measured at the origin: left where the last tip was — clamped against the window's
    // right edge, say — a long text would wrap into the room left there, and be placed as
    // a narrow box that then reflows wide.
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    // Opened before it is measured, since a closed bubble has no size; it is placed in the
    // same frame, so it is never drawn where it does not belong.
    bubble.setAttribute('data-open', '');
    if (typeof bubble.showPopover === 'function' && !popoverOpen(bubble)) bubble.showPopover();
    const at = placeTip(
      el.getBoundingClientRect(),
      bubble.getBoundingClientRect(),
      { width: view.innerWidth, height: view.innerHeight },
      el.dataset.tipSide === 'right' ? 'right' : 'below',
    );
    bubble.style.left = `${at.left}px`;
    bubble.style.top = `${at.top}px`;
    bubble.dataset.side = at.side;
  };

  const schedule = (el: HTMLElement) => {
    if (shown === el || pending === el) return;
    cancel();
    const warm = shown !== null || view.performance.now() - closedAt < WARM_MS;
    if (warm) return show(el);
    pending = el;
    timer = setTimeout(() => show(el), SHOW_DELAY_MS);
  };

  const onOver = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const el = tipTarget(event.target);
    if (el === null) return;
    if (el === pressed) return;
    schedule(el);
  };

  const onOut = (event: PointerEvent) => {
    const from = tipTarget(event.target);
    if (from === null) return;
    // Moving between the parts of one control — the glyph and the button around it — is
    // not leaving it.
    if (event.relatedTarget instanceof Node && from.contains(event.relatedTarget)) return;
    if (from === pressed) pressed = null;
    if (from === shown || from === pending) hide();
  };

  // A press is the answer to the question the tip was asking, and what it does — a sheet,
  // a menu — is about to appear where the bubble is.
  const onDown = (event: PointerEvent) => {
    pressed = tipTarget(event.target);
    hide();
  };

  // Keyboard focus shows it at once; there is no sweep to wait out. Focus that came from a
  // click is left alone, or every pressed button would wear its label afterwards.
  const onFocus = (event: FocusEvent) => {
    const el = tipTarget(event.target);
    if (el === null || el !== event.target || !focusVisible(el)) return;
    show(el);
  };

  const onBlur = (event: FocusEvent) => {
    if (event.target === shown) hide();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && shown) hide();
  };

  // Placed once, against where the control was. Anything that moves it closes the bubble
  // rather than leaving it pointing at the wrong thing.
  const onMove = () => hide();

  doc.addEventListener('pointerover', onOver);
  doc.addEventListener('pointerout', onOut);
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('focusin', onFocus);
  doc.addEventListener('focusout', onBlur);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', onMove, true);
  view.addEventListener('resize', onMove);
  view.addEventListener('blur', onMove);

  return () => {
    hide();
    doc.removeEventListener('pointerover', onOver);
    doc.removeEventListener('pointerout', onOut);
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('focusin', onFocus);
    doc.removeEventListener('focusout', onBlur);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', onMove, true);
    view.removeEventListener('resize', onMove);
    view.removeEventListener('blur', onMove);
    bubble.remove();
  };
}

/**
 * How long the pointer rests before the first bubble. Long enough that a pointer crossing
 * a toolbar on its way somewhere else does not set off a row of flashes, short enough to
 * feel like an answer rather than a wait.
 */
export const SHOW_DELAY_MS = 350;

/** After a bubble closes, how long the next control shows its own at once. */
export const WARM_MS = 600;

/** The gap between the control and the bubble, and the least margin to the window's edge. */
const GAP = 6;
const EDGE = 8;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the bubble goes: centred under the control, or over it when there is no room
 * below — the selection bar sits on the floor of the screen — and slid sideways to stay
 * inside the window rather than clipped at its edge.
 *
 * Under by default because most of the controls that carry a tip are in bars along the
 * top, and a bubble over them would cover the title or the tab beside them. A control in
 * a column of them — the rail drawn as a strip of icons — asks for `right`
 * (`data-tip-side`), since under it is the next icon, and a bubble there hides the very
 * thing the pointer is about to look at.
 */
export function placeTip(
  control: Box,
  tip: Pick<Box, 'width' | 'height'>,
  viewport: { width: number; height: number },
  prefer: 'below' | 'right' = 'below',
): { left: number; top: number; side: 'below' | 'above' | 'right' } {
  const clamp = (value: number, size: number, room: number) =>
    Math.round(Math.max(EDGE, Math.min(value, room - EDGE - size)));
  if (prefer === 'right') {
    const right = control.left + control.width + GAP;
    if (right + tip.width <= viewport.width - EDGE) {
      const middle = control.top + control.height / 2 - tip.height / 2;
      return { left: Math.round(right), top: clamp(middle, tip.height, viewport.height), side: 'right' };
    }
  }
  const below = control.top + control.height + GAP;
  const fitsBelow = below + tip.height <= viewport.height - EDGE;
  const above = control.top - GAP - tip.height;
  const side = fitsBelow || above < EDGE ? 'below' : 'above';
  const centred = control.left + control.width / 2 - tip.width / 2;
  return {
    left: clamp(centred, tip.width, viewport.width),
    top: Math.round(side === 'below' ? below : above),
    side,
  };
}

function tipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-tip]');
}

function popoverOpen(el: HTMLElement): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    // An engine without popovers: the bubble is shown by `data-open` alone.
    return false;
  }
}

function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    // jsdom and older engines do not know the selector; a focus there counts as keyboard.
    return true;
  }
}
