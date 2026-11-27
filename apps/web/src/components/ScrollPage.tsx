import type { ReactNode } from 'react';

/**
 * A scroll box for a signed-in page that is not the notes view or settings: the consent
 * screen and connecting a phone or a device.
 *
 * The app frame (`.shell.wide`) is a window-height row that clips, so the note list and
 * the editor can scroll inside it while the page never does. Settings and Help bring
 * their own scroller (`.settings`); these pages drew one panel straight into the frame,
 * and the consent screen's foot, its Allow button with it, was cut off once it grew
 * taller than a laptop's window. A wrapper rather than a rule on `.shell-main`, which has
 * to stay unscrolled for the notes view's panes to scroll at all.
 */
export function ScrollPage({ children }: { children: ReactNode }) {
  return <div className="page-scroll">{children}</div>;
}
