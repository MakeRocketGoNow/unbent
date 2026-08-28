import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface OverflowItem {
  label: ReactNode;
  /** Omitted for a link item, which navigates instead of running a handler. */
  onSelect?: () => void;
  /**
   * Renders the item as an anchor with `download`.
   *
   * A download has to be a real link: the browser must stream the response to disk
   * itself, and a button that fetched the bytes first would buffer a note's attachments
   * in memory. An anchor also keeps Save-Link-As and middle-click working.
   */
  href?: string;
  /** Destructive items are tinted and sorted to the bottom by the caller. */
  tone?: 'default' | 'danger';
  /**
   * Extra class, for an item that belongs to only one side of the breakpoint.
   *
   * The workspace promotes some of these controls to buttons in the head on a desktop and
   * tags its copies here `mobile-only`, so they are not offered twice at that width.
   */
  className?: string;
}

/**
 * The "⋯" menu in the workspace head.
 *
 * Inline and absolutely positioned rather than a portal with a focus trap — the same
 * choice `Confirm` makes, and for the same reason: nothing else in this app portals, and a
 * menu of three items does not need the machinery. Escape and an outside click close it,
 * which is what a native menu does and what people try first.
 *
 * Items are plain buttons in a list rather than `role="menu"`. The full menu pattern
 * demands roving tabindex and arrow-key navigation to be correct, and a half-implemented
 * `role="menu"` reads worse to a screen reader than honest buttons do — Tab moves through
 * them and Enter picks one, which is the behaviour the markup already promises.
 */
export function OverflowMenu({ label, items }: { label: string; items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // pointerdown, not click: a click that lands outside should dismiss the menu without
    // also activating whatever it hit, and pointerdown fires first.
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div
      className="overflow"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          setOpen(false);
          // Escape should leave focus on the trigger, not wherever the menu was.
          wrap.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        type="button"
        className="overflow-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>

      {open && (
        <div className="overflow-list">
          {items.map((item, i) => {
            const className = [
              'overflow-item',
              item.tone === 'danger' ? 'danger' : '',
              item.className ?? '',
            ]
              .filter(Boolean)
              .join(' ');

            // Anchor and button both sit in the tab order and both activate on Enter, so
            // the keyboard behaviour the list promises holds either way.
            return item.href === undefined ? (
              <button
                key={i}
                type="button"
                className={className}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ) : (
              <a
                key={i}
                className={className}
                href={item.href}
                download
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
