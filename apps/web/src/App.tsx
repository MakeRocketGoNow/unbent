import { useState } from 'react';
import { useSession, signOut } from './auth-client.js';
import { Login } from './components/Login.js';
import { Notes } from './components/Notes.js';
import { Import } from './components/Import.js';

export function App() {
  const { data: session, isPending } = useSession();
  const [showImport, setShowImport] = useState(false);
  // Bumping this remounts Notes so it refetches after an import.
  const [refreshKey, setRefreshKey] = useState(0);

  if (isPending) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="shell centered">
        <Login />
      </main>
    );
  }

  return (
    <main className="shell wide">
      <header className="topbar">
        <h1>Unbent</h1>
        <div className="account">
          {/* A plain link, not fetch+blob: the response streams, and letting the browser
              handle it means a large export never lands in a JS buffer. */}
          <button type="button" className="link" onClick={() => setShowImport((v) => !v)}>
            Import
          </button>
          <a className="link" href="/api/export" download>
            Export
          </a>
          <span className="muted">{session.user.email}</span>
          <button type="button" className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {showImport && (
        <Import
          onClose={() => setShowImport(false)}
          onImported={() => setRefreshKey((k) => k + 1)}
        />
      )}

      <Notes key={refreshKey} />
    </main>
  );
}
