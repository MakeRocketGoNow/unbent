import type { AppConfig } from '@unbent/shared';

/**
 * Marks a tab of an instance that is not production: its label in front of the title,
 * and a badge on the favicon.
 *
 * Every instance's tab used to read "Unbent" — production, dev.unbent.app, each PR's
 * preview, a local `pnpm dev` — and the costly mistake is editing the real notes while
 * believing it is a scratch copy, or the other way round. The tab strip and the window
 * switcher show the title; a pinned tab shows only the favicon, so both carry it.
 *
 * Deliberately not a banner or a tinted page. A preview exists to review a PR's UI, and
 * a strip across the top takes height on a phone and moves the sticky headers being
 * reviewed, while a tint changes the colours being reviewed, in both themes. Every layout
 * PR would be judged in a frame production never has. The title and the favicon are
 * outside the page, so they cost the layout nothing.
 */
export function applyInstanceMarker(config: Pick<AppConfig, 'instanceLabel'>): void {
  const label = config.instanceLabel;
  if (!label) return;
  document.title = instanceTitle(label, document.title);
  void badgeFavicon();
}

/** `PR 222 · Unbent`. Not doubled if the title already carries it. */
export function instanceTitle(label: string, title: string): string {
  const prefix = `${label} · `;
  return title.startsWith(prefix) ? title : `${prefix}${title}`;
}

/**
 * The account menu's line for this instance, or nothing on production. On a preview it
 * also says whose notes these are, which is the thing that decides whether an edit here
 * reaches the dev instance: one of a store-changing PR keeps its own, every other preview
 * reads and writes the dev instance's.
 */
export function instanceLine(
  config: Pick<AppConfig, 'instanceLabel' | 'ownStores' | 'previewRelay'>,
): string | null {
  const label = config.instanceLabel;
  if (!label) return null;
  if (config.ownStores) return `${label} · notes are its own`;
  if (config.previewRelay) return `${label} · notes are ${new URL(config.previewRelay.origin).host}'s`;
  return label;
}

/**
 * The app icon with a dot in its corner, drawn once on load, in `--instance-mark` from
 * styles.css — the same colour as the account menu's dot, so the two read as one mark.
 *
 * Drawn rather than shipped as a second file, so it cannot drift from the real icon when
 * that changes. If anything fails — no canvas, the icon did not load — the tab keeps the
 * plain icon, and the title still says which instance it is.
 */
async function badgeFavicon(): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  try {
    const icon = new Image();
    icon.src = link.href;
    await icon.decode();
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(icon, 0, 0, size, size);
    // A white ring first, so the dot stays separate from the green behind it at 16px.
    ctx.beginPath();
    // Tucked into the corner, clear of the letter: a badge, not a smudge on the mark.
    ctx.arc(size - 12, 12, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(size - 12, 12, 9, 0, Math.PI * 2);
    ctx.fillStyle =
      getComputedStyle(document.documentElement).getPropertyValue('--instance-mark').trim() || '#e8a33a';
    ctx.fill();
    link.href = canvas.toDataURL('image/png');
  } catch {
    // The plain icon stays; see above.
  }
}
