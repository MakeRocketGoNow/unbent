import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/trash/')({
  component: () => (
    <section className="workspace empty">
      <p className="muted">Select a deleted note to read it.</p>
    </section>
  ),
});
