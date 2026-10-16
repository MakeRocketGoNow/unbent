import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { LegalDocument } from '../legal/documents.js';

/**
 * One renderer for both legal documents.
 *
 * Deliberately not the Markdown pipeline. `Preview` is bound to a note (it takes a note id
 * and resolves attachments against it), and `renderMarkdown` runs `remarkBreaks`, which
 * turns every wrapped line into a `<br>`. Legal prose is long and hand-wrapped, so it would
 * arrive full of spurious line breaks. The content is a small tree in `legal/documents.ts`
 * instead, which is also what keeps the text editable without touching JSX.
 *
 * The typography comes from `.preview`, which is already tuned for long-form reading at a
 * measured column width; `.legal` adds only what a standalone document needs on top.
 */
export function LegalDoc({ doc }: { doc: LegalDocument }) {
  // `/terms#refunds` is the address handed to Paddle's review (`LegalSection.id`), and on a
  // fresh tab it missed: `LegalPage` draws nothing until `/api/config` has answered, so the
  // one scroll the browser and the router make for a fragment, at load, found no element
  // with that id. Scrolled again here, once the document is in the DOM. Guarded because
  // jsdom has no `scrollIntoView`, as `Confirm` guards it.
  //
  // Keyed on the title, not `doc`: `LegalPage` builds the documents on every render, so
  // `doc` is a new object each time, and on it the effect would pull a reader who had
  // scrolled away back to the fragment whenever the config query refetched or a parent
  // redrew. Once per document drawn is the intent.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView?.();
  }, [doc.title]);

  return (
    <article className="preview legal">
      <h1>{doc.title}</h1>
      <p className="legal-effective">
        Effective{' '}
        <time dateTime={doc.effective}>
          {new Date(`${doc.effective}T00:00:00Z`).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          })}
        </time>
      </p>

      {doc.intro.map((text, i) => (
        <p key={i} className="legal-intro">
          {text}
        </p>
      ))}

      {doc.sections.map((section) => (
        <section key={section.heading ?? section.body?.[0] ?? section.steps?.[0]} id={section.id}>
          {section.heading && <h2>{section.heading}</h2>}
          {section.body?.map((text, i) => <p key={i}>{text}</p>)}
          {section.steps && (
            <ol className="legal-steps">
              {section.steps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          )}
          {section.list && (
            <ul>
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {/* `/`, which is wherever this reader belongs: their notes if signed in, the
          front page on the public instance, and the sign-in screen anywhere else. It
          used to be `/login`, when `/` only bounced through the gated note list. */}
      <p className="legal-back">
        <Link to="/">Back to Unbent</Link>
      </p>
    </article>
  );
}
