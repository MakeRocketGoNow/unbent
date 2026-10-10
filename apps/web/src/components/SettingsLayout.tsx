import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { BackArrow } from './BackArrow.js';
import { isHosted, postToApp } from '../app-bridge.js';
import { useImportRunning } from '../import-run.js';
import { useOperator } from '../use-operator.js';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';

const TABS = [
  { to: '/settings/notebooks', label: 'Notebooks' },
  { to: '/settings/tags', label: 'Tags' },
  { to: '/settings/import', label: 'Import' },
  { to: '/settings/export', label: 'Export' },
  { to: '/settings/offline', label: 'Offline' },
  { to: '/settings/maintenance', label: 'Maintenance' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/connected-apps', label: 'Connected apps' },
] as const;

/**
 * The plan (MAK-108), drawn only where the instance sells one (`config.billing`). After
 * the pages that configure the app and before About: it is about the account's standing
 * rather than its settings, and a self-hosted instance never has it.
 */
const PLAN_TAB = { to: '/settings/plan', label: 'Plan' } as const;

// Last: what the app is, read rarely, after everything that configures it.
const ABOUT_TAB = { to: '/settings/about', label: 'About' } as const;

/**
 * The operator's page, drawn only for a session that runs the instance (`useOperator`).
 * After About rather than among the account's own pages: it is about the instance, not
 * this account, and it is the one tab here most people never see.
 */
const OPERATOR_TAB = { to: '/settings/operator', label: 'Operator' } as const;

/**
 * The settings section: one heading, one sub-nav, one outlet.
 *
 * These four pages accreted as separate topbar links until the topbar read as a list of
 * unrelated verbs — and maintenance never got a link at all, ending up buried inside the
 * import panel. They are all "configure the app", so they belong behind one entry with
 * their own nav.
 */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const importRunning = useImportRunning();
  const operator = useOperator();
  const billing = useQuery(configQuery()).data?.billing !== undefined;
  const tabs = [...TABS, ...(billing ? [PLAN_TAB] : []), ABOUT_TAB, ...(operator ? [OPERATOR_TAB] : [])];

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
          {/* Live during an import: the run is held by `import-run.ts`, not by its page,
              so leaving the page no longer ends it. These used to go inert for the run. */}
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className="settings-nav-item"
              activeProps={{ className: 'settings-nav-item active' }}
            >
              {tab.label}
            </Link>
          ))}
          {/*
              The Android app's own settings: which instance it talks to, and its version.
              Only inside the app, where they exist.

              A pill beside the others rather than a button of its own, because it is the
              same gesture — go to a settings page — and only its destination differs: a
              native screen, which no anchor can reach, hence a `<button>`. Inert during an
              import, unlike its siblings: the run outlives the page but not the site, and
              changing the instance from that screen reloads the site under it.
          */}
          {isHosted() &&
            (importRunning ? (
              <span className="settings-nav-disabled" aria-disabled="true">
                App settings
              </span>
            ) : (
              <button
                type="button"
                className="settings-nav-item"
                onClick={() => postToApp({ type: 'app-settings' })}
              >
                App settings
              </button>
            ))}
        </nav>

        <div className="settings-body">{children}</div>
      </div>
    </>
  );
}
