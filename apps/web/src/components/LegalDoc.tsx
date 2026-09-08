import { Link } from '@tanstack/react-router';
import type { LegalDocument } from '../legal/documents.js';

/**
 * One renderer for both legal documents.
 *
 * Deliberately not the Markdown pipeline. `Preview` is bound to a note — it takes a note id
 * and resolves attachments against it — and `renderMarkdown` runs `remarkBreaks`, which
 * turns every wrapped line into a `<br>`. Legal prose is long and hand-wrapped, so it would
 * arrive full of spurious line breaks. The content is a small tree in `legal/documents.ts`
 * instead, which is also what keeps the text editable without touching JSX.
 *
 * The typography comes from `.preview`, which is already tuned for long-form reading at a
 * measured column width; `.legal` adds only what a standalone document needs on top.
 */
export function LegalDoc({ doc }: { doc: LegalDocument }) {
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
        <section key={section.heading ?? section.body?.[0] ?? section.steps?.[0]}>
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

      {/* `/` redirects to the note list, which is gated — so a signed-out reader would
          bounce through it to the sign-in screen. Pointing there directly skips the
          detour, and someone already signed in is sent on to their notes from there. */}
      <p className="legal-back">
        <Link to="/login">Back to Unbent</Link>
      </p>
    </article>
  );
}
