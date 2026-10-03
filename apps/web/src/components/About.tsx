import type { ReactNode } from 'react';
import type { AppConfig } from '@unbent/shared';
import { buildInfo, commitDate, repoName, shortCommit, type BuildInfo } from '../build-info.js';
import { instanceNotes } from '../instance-marker.js';
import { LegalLink } from './LegalLink.js';

interface AboutProps {
  config: AppConfig | undefined;
  /** This instance's address, as the browser has it. */
  host: string;
  /** Which build this page is. Defaults to the one baked in; tests pass their own. */
  build?: BuildInfo | null;
}

/**
 * What this app is and where it is running: the build, the instance, the source, and the
 * legal documents.
 *
 * Made for the build. It was a line in the account menu first: under the address it read
 * as a third grey line of identity, and under Sign out as an afterthought. Settings is
 * about the app rather than the account, and a page here has room to say the rest — the
 * date beside the commit, whose notes a preview reads, where the source is. The menu keeps
 * the short commit on dev and previews, inside their instance line, because there it is
 * checked after every push; production's build is here alone, and `curl` reads it from
 * `index.html` without signing in.
 *
 * A definition list rather than paragraphs: these are facts read one at a time — "which
 * commit is this?" — and a label down the side is what lets an eye land on the one it
 * came for.
 */
export function About({ config, host, build = buildInfo }: AboutProps) {
  const label = config?.instanceLabel;
  const notes = config ? instanceNotes(config) : null;
  const legal = config?.legal;
  const source = build ? repoName(build) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>About</h2>
      </div>

      <dl className="about-list">
        <Fact term="Version">
          {build ? <Version build={build} /> : <span className="muted">Not recorded in this build</span>}
        </Fact>

        {/* The address alone on production; on a scratch instance, which one and, on a
            preview, whose notes an edit here changes — the menu's line, unabridged. */}
        <Fact term="Instance">
          <span className="about-value">{host}</span>
          {label && (
            <span className="muted small">{notes ? `${label} · ${notes}` : label}</span>
          )}
        </Fact>

        {build?.repo && source && (
          <Fact term="Source code">
            <a href={build.repo} rel="noopener noreferrer">
              {source}
            </a>
          </Fact>
        )}

        {/* Also in the account menu for now; here they sit with the rest of what the
            instance publishes about itself. */}
        {legal && (
          <Fact term="Legal">
            <span className="about-value">
              <LegalLink href={legal.privacy}>Privacy</LegalLink>
              <span className="muted" aria-hidden="true">
                {' · '}
              </span>
              <LegalLink href={legal.terms}>Terms</LegalLink>
            </span>
          </Fact>
        )}
      </dl>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The short commit, linked to GitHub when the build knows where it lives, and the day it
 * was made under it. A local build's commit may never have been pushed, so it is text, and
 * says when the tree it was built from had changes on top.
 */
function Version({ build }: { build: BuildInfo }) {
  const short = shortCommit(build);
  const date = commitDate(build);
  const detail = [date && `Committed ${date}`, build.dirty && 'Built with uncommitted changes']
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      {build.url ? (
        <a className="about-commit" href={build.url} rel="noopener noreferrer" title={build.commit}>
          {short}
        </a>
      ) : (
        <span className="about-commit about-value" title={build.commit}>
          {short}
        </span>
      )}
      {detail && <span className="muted small">{detail}</span>}
    </>
  );
}
