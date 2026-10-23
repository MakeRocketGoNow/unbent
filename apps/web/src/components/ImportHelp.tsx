/**
 * How to get notes out of Evernote, Notion and Joplin, for the two places that need to say it: the
 * Import panel, where the file is picked, and the front page, where someone decides whether
 * leaving is worth the trouble.
 *
 * One copy, so the two cannot drift. Notion's menus have moved before and will again, and
 * a front page promising one path while the panel describes another would be found out by
 * exactly the person who had just been persuaded.
 */

/*
 * Evernote has no export API, so the .enex has to be produced by hand before the Import
 * panel is any use at all. Someone arriving there without one had nowhere to go, which made
 * the whole feature undiscoverable for the person it is for.
 *
 * The whole-account path is a command run on the person's own computer, and this is the
 * one place the app offers it. A hosted version (sign in to Evernote here and a machine of
 * ours does the rest) was considered and declined (MAK-204). The Evernote sign-in that
 * works for every account is the desktop client's own, which a tool someone runs against
 * their own account can borrow and a service holding thousands of people's sessions cannot;
 * the sanctioned OAuth route is for paid plans and unproven against the sync API; and it
 * would pass the whole of someone's Evernote account through this instance, which the rest
 * of the app goes out of its way not to do with a single photo. If that changes, the offer
 * belongs in this paragraph, since both places that show it would need it.
 */
export function EnexHelp() {
  return (
    <details className="enex-help">
      <summary className="small">How do I get an .enex file?</summary>
      <div className="small">
        <p>
          <strong>From Evernote desktop.</strong> Select the notes or a notebook, then File →
          Export notes. Choose ENEX. The desktop app is the only place Evernote offers this; the
          web client cannot.
        </p>
        <p>
          <strong>For a whole account.</strong> Exporting tens of thousands of notes by hand is
          unreliable, and the desktop app tends to give up partway.{' '}
          <a
            href="https://github.com/MakeRocketGoNow/evernote2unbent"
            target="_blank"
            rel="noreferrer noopener"
            className="link"
          >
            evernote2unbent
          </a>{' '}
          skips the file: one command on your own computer signs in to Evernote, copies the
          account and uploads it here, and a run that stops continues when it is run again.
          With{' '}
          <a
            href="https://docs.astral.sh/uv/getting-started/installation/"
            target="_blank"
            rel="noreferrer noopener"
            className="link"
          >
            uv
          </a>{' '}
          installed, it is <code>uvx evernote2unbent migrate</code>.
        </p>
      </div>
    </details>
  );
}

/* Notion has no export API either, and its export lives three menus deep. */
export function NotionHelp() {
  return (
    <details className="enex-help">
      <summary className="small">How do I export from Notion?</summary>
      <div className="small">
        <p>
          <strong>The whole workspace.</strong> Settings → Settings → Export content → Export all
          workspace content. Choose Markdown &amp; CSV, and include subpages. Notion emails a link
          to the zip.
        </p>
        <p>
          <strong>One database or page.</strong> Open it, then ··· → Export, with the same
          choices. The zip imports the same way; it just holds less.
        </p>
      </div>
    </details>
  );
}

/*
 * Joplin's desktop app writes the JEX, Joplin's own lossless backup; its other exports
 * drop the ids and rename the attachments (see `importJoplin` for why JEX is the one
 * taken). The Markdown option sits beside it in the same menu, so the help names the
 * right one rather than leaving a coin toss.
 */
export function JoplinHelp() {
  return (
    <details className="enex-help">
      <summary className="small">How do I export from Joplin?</summary>
      <div className="small">
        <p>
          <strong>Everything.</strong> In Joplin desktop, File → Export all → JEX - Joplin Export
          File. Choose JEX rather than one of the Markdown options: it is the one that keeps
          every note&apos;s notebook, tags, dates and attachments.
        </p>
        <p>
          <strong>One notebook.</strong> Right-click it in the sidebar, then Export → JEX. A
          notebook inside another keeps the path, as in “Household / Receipts”.
        </p>
      </div>
    </details>
  );
}
