import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltips, placeTip, SHOW_DELAY_MS, WARM_MS } from './tooltips.js';

describe('placeTip', () => {
  const viewport = { width: 400, height: 300 };
  const tip = { width: 60, height: 20 };

  it('centres the bubble under the control', () => {
    expect(placeTip({ left: 100, top: 10, width: 40, height: 40 }, tip, viewport)).toEqual({
      left: 90,
      top: 56,
      side: 'below',
    });
  });

  // The selection bar sits on the floor of the screen.
  it('goes over the control when there is no room under it', () => {
    expect(placeTip({ left: 100, top: 260, width: 40, height: 40 }, tip, viewport)).toEqual({
      left: 90,
      top: 234,
      side: 'above',
    });
  });

  // The rail's strip of icons: under one is the next.
  it('goes beside a control in a column when asked, and under it when there is no room', () => {
    expect(placeTip({ left: 0, top: 100, width: 40, height: 40 }, tip, viewport, 'right')).toEqual({
      left: 46,
      top: 110,
      side: 'right',
    });
    expect(placeTip({ left: 360, top: 100, width: 40, height: 40 }, tip, viewport, 'right').side).toBe('below');
  });

  it('slides inside the window rather than past its edge', () => {
    expect(placeTip({ left: 0, top: 10, width: 20, height: 20 }, tip, viewport).left).toBe(8);
    expect(placeTip({ left: 390, top: 10, width: 10, height: 20 }, tip, viewport).left).toBe(332);
  });
});

describe('installTooltips', () => {
  let uninstall: () => void;
  let a: HTMLButtonElement;
  let b: HTMLButtonElement;

  const bubble = () => document.getElementById('app-tip')!;
  const open = () => bubble().hasAttribute('data-open');
  // jsdom has no `PointerEvent`; a mouse event with the pointer's type laid on is enough.
  const pointer = (
    type: string,
    target: Element,
    { pointerType = 'mouse', relatedTarget }: { pointerType?: string; relatedTarget?: Element | null } = {},
  ) => {
    const event = new MouseEvent(type, { bubbles: true, relatedTarget: relatedTarget ?? null });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    target.dispatchEvent(event);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <button id="a" aria-label="Tags" data-tip="Tags"><svg></svg></button>
      <button id="b" aria-label="Sort notes, currently newest" data-tip="Sort notes"></button>`;
    a = document.getElementById('a') as HTMLButtonElement;
    b = document.getElementById('b') as HTMLButtonElement;
    uninstall = installTooltips();
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it('shows after a short rest, not at once', () => {
    pointer('pointerover', a);
    expect(open()).toBe(false);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(open()).toBe(true);
    expect(bubble().textContent).toBe('Tags');
  });

  it('closes when the pointer leaves, but not when it moves onto the glyph inside', () => {
    pointer('pointerover', a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    pointer('pointerout', a, { relatedTarget: a.querySelector('svg') });
    expect(open()).toBe(true);
    pointer('pointerout', a, { relatedTarget: document.body });
    expect(open()).toBe(false);
  });

  it('shows the next control in the same sweep at once', () => {
    pointer('pointerover', a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    pointer('pointerout', a, { relatedTarget: b });
    pointer('pointerover', b);
    expect(open()).toBe(true);
    expect(bubble().textContent).toBe('Sort notes');
    pointer('pointerout', b, { relatedTarget: document.body });
    vi.advanceTimersByTime(WARM_MS);
    pointer('pointerover', a);
    expect(open()).toBe(false);
  });

  it('never shows for touch', () => {
    pointer('pointerover', a, { pointerType: 'touch' });
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(open()).toBe(false);
  });

  it('closes on a press and stays closed until the pointer leaves', () => {
    pointer('pointerover', a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    pointer('pointerdown', a);
    expect(open()).toBe(false);
    pointer('pointerover', a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(open()).toBe(false);
  });

  it('follows the text when it changes while showing', async () => {
    a.focus();
    a.dataset.tip = 'Copied';
    await Promise.resolve();
    expect(bubble().textContent).toBe('Copied');
  });
});
