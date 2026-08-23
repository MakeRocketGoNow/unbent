import { createFileRoute } from '@tanstack/react-router';

/** `/notes` with no note selected: the list is shown, the workspace is empty. */
export const Route = createFileRoute('/notes/')({
  component: () => (
    <section className="workspace empty">
      <p className="muted">Select a note, or create one.</p>
    </section>
  ),
});
