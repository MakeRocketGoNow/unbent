import { useState } from 'react';
import { useSession, signOut } from './auth-client.js';
import { Login } from './components/Login.js';
import { Notes } from './components/Notes.js';
import { Import } from './components/Import.js';
import { Settings } from './components/Settings.js';

export function App() {
  const { data: session, isPending } = useSession();
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Bumping this tells Notes to refetch after an import.
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
          <button type="button" className="link" onClick={() => setShowSettings((v) => !v)}>
            Notebooks
          </button>
          <button type="button" className="link" onClick={() => setShowImport((v) => !v)}>
            Import
          </button>
          <a className="link" href="/api/export" download>
            Export
          </a>
          <span className="muted">{session.user.email}</span>
          {/* Clearing the URL is the one history call outside use-url-state.ts: it runs
              after the component tree is gone, and leaving a note id in the address bar
              would expose it to the next person and reapply it on the next sign-in. */}
          <button
            type="button"
            className="link"
            onClick={() => void signOut().then(() => window.history.replaceState(null, '', '/'))}
          >
            Sign out
          </button>
        </div>
      </header>

      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {showImport && (
        <Import
          onClose={() => setShowImport(false)}
          onImported={() => setRefreshKey((k) => k + 1)}
        />
      )}

      <Notes refreshSignal={refreshKey} />
    </main>
  );
}
