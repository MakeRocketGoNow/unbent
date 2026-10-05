import { useId, type ReactNode } from 'react';

/**
 * A state with nothing to list: a glyph, a heading, a line about what to do, and the
 * actions to do it with, centred as one calm stack.
 *
 * The shared shape behind `EmptyLibrary` (an account with no notes) and `NotebookMissing`
 * (a link to a notebook that is not there). It was written for the first and then wanted by
 * the second, and two copies of the same stack would drift apart in spacing and motion the
 * way the app's hand-rolled disclosures once did; so the layout, the entrance and the
 * classes (`.empty-state*` in styles.css) live here, and each state says only what it says.
 *
 * A labelled region rather than a bare heading, so a screen reader's list of landmarks
 * names it the way it names the list beside it. Not `role="status"` or an alert: these
 * are places someone arrived at, not news about something that just happened, and
 * announcing them on arrival would read the page's own heading twice. The heading's level
 * is the caller's, because the page outline is: in a pane beside the list's own `h2` it
 * is an `h2`, and inside the list column, under that `h2`, it is an `h3`.
 *
 * The glyph is decoration and hidden from the accessibility tree; the heading says the
 * same thing in words.
 */
export function EmptyState({
  icon,
  heading,
  headingLevel: Heading = 'h2',
  lead,
  actions,
}: {
  icon: ReactNode;
  heading: string;
  headingLevel?: 'h2' | 'h3';
  lead: ReactNode;
  actions: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="empty-state" aria-labelledby={headingId}>
      <div className="empty-state-mark" aria-hidden="true">
        {icon}
      </div>
      <Heading id={headingId} className="empty-state-heading">
        {heading}
      </Heading>
      <p className="empty-state-lead">{lead}</p>
      <div className="empty-state-actions">{actions}</div>
    </section>
  );
}
