import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** Moves the marker, or clears it when the drag leaves or ends. */
const setDropPos = StateEffect.define<number | null>();

/**
 * A caret drawn between two characters.
 *
 * A zero-width widget rather than a styled range: the target is a position, not a
 * character, and a range decoration would have to highlight the character next to it,
 * which points at the wrong gap by half a glyph and looks like a selection.
 */
class DropCaret extends WidgetType {
  override toDOM(): HTMLElement {
    const bar = document.createElement('span');
    bar.className = 'cm-dropCursor-caret';
    // The caret is decoration, not content; without this a screen reader announces a
    // stray element mid-document while dragging.
    bar.setAttribute('aria-hidden', 'true');
    return bar;
  }

  /** All instances are identical, so CodeMirror can reuse the DOM as the position moves. */
  override eq(): boolean {
    return true;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const caret = Decoration.widget({ widget: new DropCaret(), side: 1 });

const dropPosField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setDropPos)) continue;
      return effect.value === null
        ? Decoration.none
        : Decoration.set([caret.range(effect.value)]);
    }
    // A drag does not change the document, but a concurrent save might.
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Draws the drop point at `pos`, or clears it for null.
 *
 * Exported for `noteDropZone`, which aims drops that land on the note around the editor
 * and has to show them with this same marker. Only redispatches when the position
 * actually changes; dragover fires continuously.
 */
export function showDropAt(view: EditorView, pos: number | null): void {
  const current = view.state.field(dropPosField, false);
  const existing = current?.size ? current.iter().from : null;
  if (existing === pos) return;
  view.dispatch({ effects: setDropPos.of(pos) });
}

/** Whether a drag carries files: the only drags the editor and the note around it aim. */
export function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/**
 * Refuses a dragged file, for a note that takes no changes (in the trash, or held by a
 * save conflict): the pointer says no, and no point is drawn. It used to draw the point all
 * the same, and the drop then did nothing (`attachments` takes the file and keeps it), so
 * the person aimed at a place the note was never going to put anything.
 *
 * The caller still claims the drag, or the browser would open the file. Shared with
 * `noteDropZone`, so the text and the page around it refuse alike.
 */
export function refuseFile(view: EditorView, event: DragEvent): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  showDropAt(view, null);
}

/**
 * Shows where a dragged file will land.
 *
 * The browser draws no insertion point for a drag carrying files (its own caret only
 * appears for dragged *text*), so dropping a screenshot into a note was aiming at
 * nothing. The drop handler already resolves the pointer to a document position with
 * `posAtCoords`; this draws that same position while the pointer is still moving, so what
 * you see during the drag is exactly what the drop uses.
 *
 * Files only. A text drag gets the browser's native caret, and drawing a second one
 * beside it would be worse than drawing none.
 */
export function fileDropCursor(): Extension {
  return [
    dropPosField,
    EditorView.domEventHandlers({
      dragover(event, view) {
        if (!carriesFiles(event)) return false;
        // Also claims the drag, without which the browser navigates to the file on drop.
        event.preventDefault();
        if (view.state.readOnly) {
          refuseFile(view, event);
          return false;
        }
        // `posAtCoords` measures rendered geometry, so it throws where there is none:
        // a headless test environment, or a pointer over a line that has been scrolled
        // out of the rendered viewport. Neither is worth failing a drag over: without a
        // position there is simply nothing to point at, and the drop still lands
        // correctly via its own lookup.
        let pos: number | null = null;
        try {
          pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        } catch {
          pos = null;
        }
        showDropAt(view, pos);
        return false;
      },
      dragleave(event, view) {
        // Fires for every child element the pointer crosses, so a plain clear would
        // flicker the caret off on the way between two lines. Only a departure from the
        // editor itself counts.
        const to = event.relatedTarget as Node | null;
        if (to && view.dom.contains(to)) return false;
        showDropAt(view, null);
        return false;
      },
      drop(event, view) {
        if (carriesFiles(event)) showDropAt(view, null);
        return false;
      },
      dragend(_event, view) {
        showDropAt(view, null);
        return false;
      },
    }),
    EditorView.baseTheme({
      '.cm-dropCursor-caret': {
        display: 'inline-block',
        width: '2px',
        // Sits on the text baseline without adding to the line's height.
        height: '1.2em',
        verticalAlign: 'text-bottom',
        marginInline: '-1px',
        background: 'var(--accent)',
        animation: 'cm-dropCursor-blink 1s steps(2, start) infinite',
      },
      '@keyframes cm-dropCursor-blink': {
        '0%': { opacity: '1' },
        '100%': { opacity: '0.35' },
      },
    }),
  ];
}
