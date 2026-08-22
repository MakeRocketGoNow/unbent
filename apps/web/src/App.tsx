import { useEffect, useState } from 'react';
import { api } from './api.js';

interface HealthState {
  status: string;
  db: string;
  latencyMs: number;
  dbError?: string;
}

export function App() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.api.health
      .$get()
      .then(async (res) => {
        const body = (await res.json()) as HealthState;
        if (!cancelled) setHealth(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <h1>Unbent</h1>
      <p className="tagline">Notes in Markdown that you can always take with you.</p>

      <section className="status">
        <h2>API</h2>
        {error && <p className="bad">Unreachable: {error}</p>}
        {!error && !health && <p className="muted">Checking…</p>}
        {health && (
          <p className={health.status === 'ok' ? 'good' : 'bad'}>
            {health.status} · db {health.db} · {health.latencyMs}ms
            {health.dbError ? ` · ${health.dbError}` : ''}
          </p>
        )}
      </section>
    </main>
  );
}
