import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { BackArrow } from './BackArrow.js';

interface BusyContext {
  /** Set while an import is running, so the sub-nav can refuse to unmount it. */
  importRunning: boolean;
  setImportRunning: (running: boolean) => void;
}

const SettingsBusy = createContext<BusyContext>({
  importRunning: false,
  setImportRunning: () => {},
});

/**
 * Lets the import tell the navigation it is mid-run.
 *
 * The import lives entirely in the browser, so navigating away unmounts it and terminates
 * its worker — losing however many thousand notes were left to go. It had a route of its
 * own for exactly that reason; putting it in a section with siblings hands the same foot
 * gun back unless the links go inert while it runs. The desktop's rail is a dozen more
 * ways out beside the page, so it reads this too.
 */
export function useSettingsBusy() {
  return useContext(SettingsBusy);
}

/**
 * Owns the flag, above everything that reads it.
 *
 * The section used to own it, which was enough while the section's own sub-nav was the
 * only navigation on screen beside a running import. The rail stands outside the section,
 * so the flag has to be held where both can reach it: the signed-in shell mounts this
 * around the rail and the routed content alike.
 */
export function SettingsBusyProvider({ children }: { children: ReactNode }) {
  const [importRunning, setImportRunning] = useState(false);
  const busy = useMemo(() => ({ importRunning, setImportRunning }), [importRunning]);
  return <SettingsBusy.Provider value={busy}>{children}</SettingsBusy.Provider>;
}

const TABS = [
  { to: '/settings/notebooks', label: 'Notebooks' },
  { to: '/settings/tags', label: 'Tags' },
  { to: '/settings/import', label: 'Import' },
  { to: '/settings/export', label: 'Export' },
  { to: '/settings/maintenance', label: 'Maintenance' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/connected-apps', label: 'Connected apps' },
] as const;

/**
 * The settings section: one heading, one sub-nav, one outlet.
 *
 * These four pages accreted as separate topbar links until the topbar read as a list of
 * unrelated verbs — and maintenance never got a link at all, ending up buried inside the
 * import panel. They are all "configure the app", so they belong behind one entry with
 * their own nav.
 */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const { importRunning } = useSettingsBusy();

  return (
    <>
      <div className="settings">
        <div className="settings-head">
          {/*
              The way back, on a phone only.

              This was a "← Back to notes" text link on the right of this row at every
              width. On a desktop it was a third route to a list the rail beside it already
              reaches from every place it lists, strip or open. On a phone it was
              a 25px target in the top-right corner — the corner a phone reserves for
              forward actions — while every other full-screen view here puts a 44px arrow
              top-left.

              So it is the same `.view-back` the note and trash views use, in the same
              place, and the heading beside it says where it goes.
          */}
          <Link to="/notes" className="view-back" aria-label="Back to notes">
            <BackArrow />
          </Link>
          <h2>Settings</h2>
        </div>

        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((tab) =>
            importRunning && tab.to !== '/settings/import' ? (
              // Inert rather than hidden: the section should not appear to lose pages
              // mid-import, but a stray click must not cost a long-running import.
              <span key={tab.to} className="settings-nav-disabled" aria-disabled="true">
                {tab.label}
              </span>
            ) : (
              <Link
                key={tab.to}
                to={tab.to}
                className="settings-nav-item"
                activeProps={{ className: 'settings-nav-item active' }}
              >
                {tab.label}
              </Link>
            ),
          )}
        </nav>

        {importRunning && (
          <p className="muted small">
            An import is running. The other settings pages are unavailable until it
            finishes or is stopped, because leaving this page would cancel it.
          </p>
        )}

        <div className="settings-body">{children}</div>
      </div>
    </>
  );
}
