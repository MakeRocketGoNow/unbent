import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface OverflowItem {
  label: ReactNode;
  onSelect: () => void;
  /** Destructive items are tinted and sorted to the bottom by the caller. */
  tone?: 'default' | 'danger';
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
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              className={item.tone === 'danger' ? 'overflow-item danger' : 'overflow-item'}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
