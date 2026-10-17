# Unbent

Notes, receipts and scans you can search, and take with you whenever you like.

Unbent keeps your notes, receipts and scanned paperwork together and finds them by what they
say, even a photo of a receipt. Everything in it is an ordinary file you can download
whenever you like, and if you ever stop paying, nothing is held hostage: the account turns
read-only, and every note still opens, searches and exports.

<p>
  <picture>
    <source srcset="apps/web/public/front/desktop-dark.webp" media="(prefers-color-scheme: dark)">
    <img src="apps/web/public/front/desktop-light.webp" width="640" alt="Unbent in a desktop browser: notebooks in a sidebar, a list of notes, and a note open beside them.">
  </picture>
  <picture>
    <source srcset="apps/web/public/front/phone-dark.webp" media="(prefers-color-scheme: dark)">
    <img src="apps/web/public/front/phone-light.webp" width="195" alt="Unbent on a phone: the list of notes.">
  </picture>
</p>

## Why

A lot of people kept years of their lives in Evernote: every bill, warranty, manual and
receipt, scanned once and found again by what it said. Then its owner changed, the price
roughly doubled within a year, and the way out was an export only another notes app could
read. Unbent is the app we wanted instead: the same job, done with files you own.

Leaving should be easy, and staying should never depend on it being hard. The longer
version, told as what happened to one archive, is [Why Unbent exists](https://unbent.app/why).

## What it does

The first four are the paperless office, in order: scan the bills, receipts, manuals and
letters once and recycle the paper.

- **Scan it, drop it in.** Drop a stack of PDFs or photos on the list and each becomes a
  note with the file attached. Install the app and it registers as a handler for PDFs and
  images, so a scanner's "send to application" step lands straight in it.
- **Files a scan with one press.** Press Auto-fill and an AI reads the scan and fills in
  its title, its notebook and any empty fields: the date, the total, who it was from. You
  check it instead of typing it, and it only runs when you press it.
  [Auto-fill](docs/search.md#filing-a-note-from-what-it-says).
- **Finds things by what they say.** Search reaches the text of every PDF you attach, and
  pictures and scans are read too, so a photo of a receipt turns up under the name of the
  shop. [Search](docs/search.md).
- **Notebooks that work like a spreadsheet.** A notebook can carry typed fields (dates,
  amounts, selects, ratings), be seen as a table and filtered by any of them. Receipts by
  month, warranties by when they run out.
- **Works with your AI assistant, and is off until you say so.** Unbent is a full MCP
  server, and never sends your notes to a model on its own. [Below](#works-with-your-ai-assistant).
- **Imports from Evernote and Notion.** An ENEX export goes in whole, from the browser, and
  an interrupted import picks up where it stopped. Notion's Markdown and CSV export goes in
  the same way, each database becoming a notebook with its columns as fields.
- **Exports everything, any time.** A zip of one folder per note, with its files beside it,
  that any computer opens with nothing from us installed and any Unbent reads back in. It is
  [your own backup](docs/backups.md), and the way out.
- **Keeps your notes as plain files, never rewritten.** Every note is a Markdown file saved
  exactly as you typed it, edited by a [word-processor-like editor](docs/editor.md) that
  never reformats it. [Below](#your-notes-are-files).
- **Works offline, on every device.** The app opens with no connection: notes, notebooks
  and tags live in a [local copy](docs/sync-and-offline.md) kept current by a change feed,
  and edits made offline sync when it returns.
- **Android and iOS apps, coming soon.** The site in a web view, with native sign-in, the
  share sheet and files: [Android](docs/android.md), [iOS](docs/ios.md). Neither is in a
  store yet; until then, Unbent works in a phone's browser.

A note's [history](docs/history-and-trash.md) keeps what an edit replaced, and the trash
keeps what was deleted.

## Works with your AI assistant

Unbent is an [MCP](https://modelcontextprotocol.io) server, so Claude, ChatGPT, Cursor or
anything else that speaks the protocol can work in your notes the moment you connect it.
Connecting is an ordinary OAuth consent; Settings › Connected apps lists what you have let
in and disconnects any of it, and access ends on the next call rather than when a token
expires. About thirty tools, under the same rules the app has:

- **Read:** search notes (full text, inside files too, with filters on notebook, tag, date
  and field), list notes a page at a time with a one-line summary of each file (a receipt's
  total, dates and order number found in its text), get a note, list notebooks and tags.
- **Write:** create one note or several, edit part of a note by exact match or append to
  it without resending the rest, add or remove tags, set field values on many notes at
  once, move notes to a notebook, trash and restore, one or many.
- **Files:** read the text held for a file, see a picture (so the assistant reads a scan
  nothing has read yet with its own model, on its own bill), record what it read so search
  has it, attach a file from a URL, or upload one from the assistant's own machine through
  a one-time link.
- **Notebooks:** create, update and delete notebooks; add a field, rename or retype it,
  edit its options; rename, merge and delete tags.

Two rules hold the other half of the promise. Unbent itself never sends your notes to a
model: the one feature that uses AI, Auto-fill, runs only when someone presses it, on one
note, and there is deliberately no tool and no button that runs it across a notebook.
Filling a thousand imported receipts' fields is the assistant's job, on the assistant's
model, and [the recipe](docs/assistants.md) needs nothing beyond the tools above. And an
assistant is kept on a leash: no tool deletes anything for good (the trash is as far as it
can go), and every edit it makes is kept in the note's history, marked as the assistant's,
so you can see what it did and put it back. [Connecting an assistant](docs/assistants.md)
has the details.

## Your notes are files

Notes are Markdown with YAML frontmatter. Attachments are ordinary files. Export produces a
plain folder tree (one directory per note, containing the note's markdown and a `files/`
subdirectory) that you can read, grep, and back up without this app existing, and import
back into any Unbent.

The Markdown is the note, not a serialization of one. A note you save is byte-identical to
what you typed: no reflowed lists, no `_italic_` quietly rewritten to `*italic*`, no escaped
underscores in a filename. That is the whole promise, and it is what makes the export
guarantee worth anything: a format the app rewrites behind your back is a format you do not
actually own.

Editing it should still feel like a word processor. See [Editing](docs/editor.md).

## Use it or run your own

[unbent.app](https://unbent.app) is the hosted instance: a two-week trial, then one annual
plan, and an account that lapses stays readable and exportable. Or run your own on
Cloudflare: one Worker serves the site and the API, with a database and a bucket beside
it, and the free tier is enough.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MakeRocketGoNow/unbent)

[Running your own instance](docs/self-hosting.md) covers the button, GitHub Actions and
the laptop route, every setting an instance can take, and how sign-in methods are chosen.

## Layout

```
apps/web       Vite + React SPA
apps/api       Hono API on Workers, and the MCP server under src/mcp
apps/android   Kotlin app: the site in a WebView, with native sign-in, share sheet and files
apps/ios       Swift app: the site in a web view, with native sign-in and files
packages/shared  zod schemas, frontmatter codec, remark plugins
packages/enex    ENEX -> Markdown, runtime-agnostic
```

`apps/android` is a Gradle project, not a pnpm workspace package: `pnpm -r` skips it, and it
is built with its own wrapper. See [Android app](docs/android.md). `apps/ios` is an Xcode
project with two Swift packages beside it, skipped the same way. See [iOS app](docs/ios.md).

## Documentation

Everything else is in [docs/](docs/README.md): [setting up a checkout](docs/development.md),
[self-hosting](docs/self-hosting.md), [the editor](docs/editor.md),
[search and Auto-fill](docs/search.md), [sync and offline](docs/sync-and-offline.md),
[history and trash](docs/history-and-trash.md), [billing](docs/billing.md),
[the Android](docs/android.md) and [iOS](docs/ios.md) apps,
[architecture and durability](docs/architecture.md), [backups and export](docs/backups.md),
and the [known gaps](docs/known-gaps.md). [AGENTS.md](AGENTS.md) holds the standards the
code is held to.

## License

Unbent is source-available, not open source: the whole repository, mobile apps included,
is under the [Elastic License 2.0](LICENSE.md) (`Elastic-2.0`).

What it permits: use Unbent and modify it; run it for yourself, your family, or your own
company; redistribute the source; build the apps from it. What it forbids: offering it to
others as a hosted or managed service. That is the restriction that matters here, and it is
what keeps the hosted service viable while the code stays public. The license has two
more, which cost nothing in practice: its license-key clause, which Unbent has no license
keys for it to apply to, and its notices clause, which means keeping the copyright and
license text in any copy you pass on.

The [export guarantee](docs/backups.md) does not rest on the license. It rests on the
export itself: a plain folder of Markdown and files that needs no Unbent to read, which the
license does not touch.

Older commits carry the text of an earlier license from before the repository was public.
Nothing was ever distributed under it, and it grants no rights; [LICENSE.md](LICENSE.md)
says so at the top.

Contributions are accepted under the same terms; see [CONTRIBUTING.md](CONTRIBUTING.md).
