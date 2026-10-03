import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';

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
  /**
   * Renders the item as a router link to an in-app route.
   *
   * Distinct from `href`, which downloads: this navigates, so it must go through the
   * router rather than reloading the SPA. Middle-click and copy-link-address keep
   * working, which a button would lose.
   */
  to?: string;
  /**
   * Renders the item as an anchor to another site.
   *
   * A third kind because neither above fits: `href` downloads, and `to` is a route, so an
   * absolute URL handed to it becomes a page this app does not have rather than a
   * navigation off it. Legal documents an operator hosts themselves are why this exists —
   * see `LegalLink.tsx`, which draws the same distinction outside a menu.
   */
  external?: string;
  /** Destructive items are tinted and sorted to the bottom by the caller. */
  tone?: 'default' | 'danger';
  /** Extra class, for an item needing placement or emphasis beyond `tone`. */
  className?: string;
  /**
   * Renders the item as static text rather than a control.
   *
   * The account menu heads itself with the address it belongs to, which is a label and
   * not something you can press. As a `<button>` it still took focus on Tab and still
   * announced itself as pressable; CSS could only hide that from the mouse. A `<span>`
   * says the same thing to the pointer, the keyboard and a screen reader at once.
   */
  static?: boolean;
  /**
   * Renders a rule between groups instead of an item; `label` is ignored.
   *
   * A real element rather than a border on whichever item happens to end a group: the
   * account menu's groups change with the instance (an instance line on dev and previews,
   * legal links only where they are published), and a border had to be moved about with
   * `:has()` chains to follow them, landing on items whose padding and rounded corners
   * were never meant to carry one.
   */
  separator?: boolean;
  /** Native tooltip, for a label whose text may be truncated. */
  title?: string;
  /**
   * Marks the item as the one currently in effect.
   *
   * For a menu that is a choice rather than a list of commands — the sort menu, where one
   * of five is always active. `aria-pressed` rather than `aria-checked`: these are plain
   * buttons, not `role="menuitemradio"`, and the note above on `role="menu"` applies to
   * its children too. A half-implemented radio group reads worse to a screen reader than
   * an honest toggle does.
   *
   * Only meaningful on a button item. A link that navigates is not a setting.
   */
  selected?: boolean;
  /**
   * Shown but not available right now — Sign out in a browser with no connection. Faded
   * in place rather than dropped, so the menu keeps its shape and `title` says why. Only
   * meaningful on a button item.
   */
  disabled?: boolean;
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
interface OverflowMenuProps {
  label: string;
  items: OverflowItem[];
  /**
   * The trigger's content. Defaults to the ⋯ glyph.
   *
   * The account menu hangs the same machinery off an avatar instead — same dismissal
   * rules, same item list, different face.
   */
  trigger?: ReactNode;
  /** Extra class on the wrapper, for menus that anchor differently. */
  className?: string;
  /** Extra class on the trigger, for one that is not a ⋯-sized square. */
  triggerClassName?: string;
  /**
   * Every item needs something the page cannot do right now — offline, a note's actions
   * all do. The trigger stays where it is, faded, rather than going: a head that loses its
   * ⋯ when the connection drops moves the title under the reader's eye. `title` says why.
   */
  disabled?: boolean;
  title?: string;
}

export function OverflowMenu({
  label,
  items,
  trigger,
  className,
  triggerClassName,
  disabled = false,
  title,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // A menu left open when its actions become unavailable would offer them anyway.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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
      className={className ? `overflow ${className}` : 'overflow'}
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
        className={
          triggerClassName ? `overflow-trigger ${triggerClassName}` : 'overflow-trigger'
        }
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger ?? '⋯'}
      </button>

      {open && (
        <div className="overflow-list">
          {items.map((item, i) => {
            const className = [
              'overflow-item',
              item.tone === 'danger' ? 'danger' : '',
              item.selected === true ? 'selected' : '',
              item.className ?? '',
            ]
              .filter(Boolean)
              .join(' ');

            if (item.separator === true) {
              return <hr key={i} className="overflow-separator" />;
            }

            // A label, not a command: nothing to activate, so it is not in the tab order.
            if (item.static === true) {
              return (
                <span key={i} className={className} title={item.title}>
                  {item.label}
                </span>
              );
            }

            // Anchor, link and button all sit in the tab order and all activate on
            // Enter, so the keyboard behaviour the list promises holds for each.
            if (item.external !== undefined) {
              return (
                <a
                  key={i}
                  className={className}
                  href={item.external}
                  rel="noopener noreferrer"
                  title={item.title}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect?.();
                  }}
                >
                  {item.label}
                </a>
              );
            }

            if (item.to !== undefined) {
              return (
                <Link
                  key={i}
                  className={className}
                  to={item.to}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect?.();
                  }}
                >
                  {item.label}
                </Link>
              );
            }

            return item.href === undefined ? (
              <button
                key={i}
                type="button"
                className={className}
                // Only where it is a choice: on a command, "not pressed" is a state the
                // item does not have, and announcing one invites the question of how to
                // press it.
                aria-pressed={item.selected === undefined ? undefined : item.selected}
                disabled={item.disabled}
                title={item.title}
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
