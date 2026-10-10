/**
 * Word from the outbox that the server refused a write because the plan has ended
 * (MAK-108). The outbox lives below the React tree and holds no query client; this is
 * how the one thing that should happen next — the plan read again, so the banner and
 * the read-only editor appear — reaches `usePlan`, which listens. A set of listeners
 * rather than a DOM event, so a test can call it without a window.
 */
const listeners = new Set<() => void>();

export function onPlanRefused(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function planRefused(): void {
  for (const listener of listeners) listener();
}
