/**
 * Refuses a file dropped where nothing in the app takes it.
 *
 * A browser opens a file let go on a page that did not claim the drag: in the tab, in
 * place of the app. The note takes files anywhere on it (`noteDropZone`), but a drop that
 * missed it, onto the list beside it or the rail or a settings page, still replaced the app
 * with the picture, and Back was the only way home. This listens on the window, so every
 * part of the app that does take files has had its turn first and claimed the drag by
 * preventing its default; a drag that arrives here unclaimed is claimed and refused, so the
 * pointer says no and letting go does nothing.
 *
 * Only for drags carrying files: dragged text keeps the browser's own handling, which is
 * how it gets into a text field. A native file input is left alone too, since taking a
 * dropped file is its default action: the Import page's picker accepts one that way.
 *
 * Returns the cleanup, for tests; the app installs it once and keeps it.
 */
export function refuseStrayFileDrops(target: Window = window): () => void {
  const refuse = (event: DragEvent) => {
    if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  };
  target.addEventListener('dragover', refuse);
  target.addEventListener('drop', refuse);
  return () => {
    target.removeEventListener('dragover', refuse);
    target.removeEventListener('drop', refuse);
  };
}
