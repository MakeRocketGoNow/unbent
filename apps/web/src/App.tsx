import { useSession, signOut } from './auth-client.js';
import { Login } from './components/Login.js';
import { Notes } from './components/Notes.js';

export function App() {
  const { data: session, isPending } = useSession();

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
          <span className="muted">{session.user.email}</span>
          <button type="button" className="link" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <Notes />
    </main>
  );
}
