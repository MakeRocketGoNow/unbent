/**
 * How to get notes out of Evernote and Notion, for the two places that need to say it: the
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
            href="https://github.com/vzhd1701/evernote-backup"
            target="_blank"
            rel="noreferrer noopener"
            className="link"
          >
            evernote-backup
          </a>{' '}
          syncs the account and writes one .enex per notebook. Import them one at a time.
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
