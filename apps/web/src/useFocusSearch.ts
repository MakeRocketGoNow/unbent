import { useEffect } from 'react';

/**
 * Cmd/Ctrl+F focuses the search field, from anywhere in the notes view.
 *
 * Evernote binds a global shortcut to its search box, and this is that: wherever you are
 * (a note row, the editor, an empty stretch of chrome), one press puts the caret in search
 * ready to type. The platform key: Cmd on a Mac, Ctrl elsewhere, the pair every app uses
 * for find.
 *
 * The cost is that Cmd+F is the browser's find-in-page, and taking it means a reader can
 * no longer jump around a long note with the key their whole OS uses for it. So the browser
 * keeps its turn on the second press: Cmd+F when search is *already* focused is let through,
 * and find-in-page opens. First press searches the archive, second press searches the page,
 * the arrangement Notion settled on, and the reason to intercept the key at all rather than
 * leave find-in-page as the only thing it does. `preventDefault` is therefore conditional:
 * it fires only when this handler is going to move focus, never when it steps aside.
 *
 * Captured (the `true` third argument) so it runs before CodeMirror's own key handling: the
 * editor is a `contentEditable` surface that would otherwise swallow the combo, and the
 * whole point is that Cmd+F reaches search from inside the note too.
 *
 * The field may not be mounted (a phone's is behind its search icon), so this no-ops when
 * the ref is empty. A phone has no key to press anyway; this is a desktop affordance.
 */
export function useFocusSearch(field: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const input = field.current;
      if (!input) return;
      // Already in the field: this press is the browser's, so find-in-page can open.
      if (document.activeElement === input) return;
      e.preventDefault();
      input.focus();
      // Select what is there, so a fresh search overtypes the old term rather than
      // appending to it: the same thing focusing a browser's address bar does.
      input.select();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [field]);
}
