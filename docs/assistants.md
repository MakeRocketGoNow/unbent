# Connecting an AI assistant

Unbent is an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor, ChatGPT or
anything else that speaks the protocol can work with your notes directly. The server URL is
`https://unbent.app/api/mcp`: no trailing slash, and no API key to copy anywhere.

Connecting runs the ordinary OAuth flow: the client registers itself, a browser opens on the
consent screen, and approving it hands the client a token of its own. The tools cover
search and list, reading a note in full, create, edit, tag, move, trash and restore (create
and the last four for several notes at once), attaching a file, and notebook management. Note bodies are Markdown and pass whole in both
directions, so an assistant writes a complete note in one call. Once it is connected,
[standing instructions](#standing-instructions) tell it when to use Unbent without being
asked by name.

Three are worth knowing about:

- **`edit_note`** takes `append`, `prepend`, or `replace` with an exact `find` string, so
  changing one line of a long note does not mean resending it. A `find` matching more than
  once is refused with the count rather than guessed at.
- **`get_attachment_text`** returns the text held for a file: a PDF's text layer, which is
  what makes a scanned bill answerable; what the vision model read off a picture or a
  text-less scan when someone pressed Auto-fill on its note; or what an assistant recorded
  itself. A picture nothing has read yet is reported as waiting, and no tool makes the
  instance's model read it: that runs only inside a press (MAK-179). Instead
  **`get_attachment`** hands the assistant the picture itself, as an image under about 3.7 MB, to
  read with its own model on its own bill, and **`set_attachment_text`** records what it
  read, marked `assistant`, so search and the summaries have it. It may fill a file that
  has no text, an empty row or its own earlier words, and never a text layer or the model's
  reading; the next Auto-fill press on the note has the model read the file itself and
  replaces it. See [Searching inside PDFs](search.md#searching-inside-pdfs). Before any of that, `get_note`
  (and `list_notes` or `search_notes` with `attachmentSummaries`) already give each file a
  line of what it is: the vision model's name and description for a picture or a text-less
  scan; for a text layer, its opening and then the total, dates, order number and amounts
  found in it by pattern, so a receipt's total at the foot of the page is in the line; or
  whether it is still waiting. No language model writes a text layer's line: the summary is
  worked out from the text each time it is asked for, so every file has one and there is
  nothing to backfill.
  Filling a notebook's fields from its receipts is then a page of a hundred notes read in
  one call, rather than two calls for every note. Where the line is not enough,
  `get_attachment_text` takes `maxChars` to return only the opening of the text, the part
  a receipt's merchant and total are in, rather than the pages of terms after it. A cut
  answer says how long the whole text is, and `offset` reads on from where it stopped.
- **`add_attachment`** takes a URL, not bytes. A tool call is JSON the model writes token by
  token, so a file cannot ride in one: a scan as base64 is millions of characters, past
  what any client carries. What an assistant can hand over is the download link another
  system gave it when it read the page (a signed URL, typically good for an hour), and the
  Worker fetches that itself and stores the result exactly as an upload from the editor.
  The reply carries the filename it was stored under and the Markdown that shows it, which
  is appended to the note unless the assistant asks to place it. A file with no link (one
  on the assistant's own disk, or a screenshot in its sandbox) goes the other way:
  **`prepare_attachment_upload`** hands back a one-time URL, and the assistant's shell
  sends the bytes there with `curl -T`. The reply to that request is the same as
  `add_attachment`'s. The link works once, for one note, for half an hour, and needs no
  token beside it, so the shell never holds the client's OAuth credentials. The one
  requirement is that the assistant can reach this instance over the network: a sandbox
  that restricts where it connects needs the instance's domain allowed. There is still
  deliberately no tool that takes the bytes as an argument: it would work only for files
  small enough not to matter, and fail silently above that.

**Filling a notebook's fields in bulk is an assistant's job, on the assistant's own
model.** Pressing Auto-fill fills one note's empty fields, and there is deliberately no
button, and no tool, that runs it across a notebook: a press that ran a few hundred notes
would be a few hundred model calls on the instance's bill, which no daily cap on presses
can bound and no flat price can cover (MAK-176, canceled under MAK-178). The notebook that
needs it is usually one that existed before its fields did, and that is a one-off. The
recipe needs nothing beyond the tools above:

1. `list_notes` with `notebook`, `compact`, and `fields` set to
   `[{"field": "Merchant", "op": "empty"}]` lists the notes still to fill, five hundred a
   page. With `include` naming the fields instead, a page shows which are empty.
2. The same list without `compact` and with `attachmentSummaries` carries, for each note's
   scans, the total, the dates, an order number and the amounts found in the text by
   pattern, which fills most of a receipt's fields with no further call. Where it is not
   enough, `get_attachment_text` with `maxChars` reads the opening of the file, where a
   merchant and a total are.
3. `update_note` sets that note's values; `update_note_fields` sets the same values on
   many notes at once, which suits a column that is the same across a batch. Both refuse
   a value that does not fit its field, and each write is kept in the note's history as
   the assistant's.

Read what is there before writing: a value a person set is theirs, and the `empty` filter
is what keeps a second pass from touching it. A picture nothing has read yet shows as
waiting in the summaries; `get_attachment` hands it over to read, as above, rather than
having the instance read it.

**An assistant can tell the operator what got in its way.** `send_feedback` takes a
category (a wrong or unhelpful result, an error with no way forward, a missing capability,
a misleading description, slowness, or praise), the tool it is about, and a few sentences,
and keeps them for the operator page's Assistant feedback list, with the account and the
app that sent them. The idea is [Axiom's](https://axiom.co/blog/the-agents-would-like-a-word-with-you):
the assistant is the only one who sees a tool fail it, and the person it is working for
is not going to write in about a tool description. Its description tells the model when to
call it and never to quote the person's notes, since the operator reads it with the
account named. An account's assistants may send twenty a day and the same words only once,
the whole instance keeps five hundred a day, and the rows go after ninety days or with the
account. The privacy policy says what is kept and for how long.

**Approving a client gives it standing access to everything.** It can read every note,
create and change notes, and move them to the trash, from then on and without asking again.
Settings › AI assistants lists what is connected and disconnects any of it; disconnecting
deletes the app's tokens, and the endpoint checks the grant on every call, so access ends
rather than lingering until a token expires. There is deliberately no tool that deletes
permanently: the trash is as far as an assistant can go. And what an assistant's edit
replaces is kept: see [Undoing an edit](history-and-trash.md#undoing-an-edit).

Client registration is open, because clients register themselves at connect time and there
is no way to pre-provision credentials for software you have never heard of. A registered
client with no approved consent can read nothing; the registration endpoint is rate limited
so the table cannot grow quickly. A public client whose redirects are all `http://localhost`,
`127.0.0.1` or `[::1]` is registered as a native app even when it does not say so, as the
MCP SDK does not; one that keeps a secret and redirects to this machine is refused with a
message saying to register it as native.

Locally, point the client at the **SPA** origin rather than the Worker's: the port
`pnpm dev` prints first. Tokens are bound to the MCP endpoint's URL as their audience, and
that URL is built from `APP_URL`.

## Standing instructions

A connected assistant uses Unbent when it is asked to, which leaves the person saying "in
Unbent" at the end of every request. Standing instructions, the text an assistant reads at
the start of every chat, are what make "file this", "log this" or "look up X in my notes"
mean Unbent without naming it. Settings › AI assistants writes them, under "Tell it when to
use Unbent", in one version for each place they are pasted.

Each is built from the account's notebooks at the moment it is copied. It says what
Unbent is and the address of this instance's server (never unbent.app's), which requests
mean it, then lists the notebooks as a plain inventory: each one's name, its purpose in
the person's own words when it has one, and its fields with what each takes ("Rating (1
to 5)", "Amount (USD)", "Would Get Again (one of Yes, Maybe, No)"). That gives the
assistant the shape of the library before its first call, which is what a one-line entry
typed on a phone needs. It then says how to write: read `list_notebooks` first and file
by each notebook's purpose and field names, leave out what the person did not give, use
the options a field already has, create no notebooks or fields unasked, and answer with
the note's link. The text is at most 5,000 characters; a library too large for that loses
its option lists, then its field lists, then its purposes, and only then names the busiest
notebooks and counts the rest. Nothing can update a text once it is pasted into another
app's settings, so copy it again after adding a notebook or a field; a notebook added in
between is still found, since the assistant reads `list_notebooks` before it writes.

The inventory says nothing about what a notebook is for beyond its purpose. A first
version sorted notebooks into logs, records and reference from their field shapes and
told the assistant what to do with each, and that was one person's notebooks generalized.
The purpose, written on the notebook under Settings › Notebooks and carried by
`list_notebooks` to every assistant, is the specific instruction: "Meals out: one note
per visit, with the date and a rating" says more than any guess from the fields, in the
words of the person who keeps it.

The text also leaves the assistant's own memory alone. Claude and ChatGPT remember what
comes up in conversation, and the text does not ask them to put that in Unbent instead:
Unbent is where the person files things on purpose, and the instructions only route the
requests that say so. The one exception is the Project version, where the person has
chosen a place for filing and every message in it is read as something to file or look up.

Where each goes, as each app's help pages describe it (checked 2026-10-26):

- **Claude, in every chat.** Settings › Your Claude › Instructions (Settings › Account ›
  Instructions for Claude in the older layout). It is account-wide, so it applies in the
  web app, the desktop app and the mobile apps alike. The connector is added once, under
  Customize › Connectors › Add custom connector, and works from every Claude app, since
  Claude reaches the server from Anthropic's side whichever app is in use. See
  [personalization](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)
  and [custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- **A Claude Project for filing.** Create a project at claude.ai/projects, then Set
  project instructions. Only that project's chats read it, and there every message is
  taken as something to file or look up, so a line typed on a phone with no verb at all
  is a note. Open the project in the mobile app to file from a phone. Projects are on
  every plan; a free account has five. See
  [projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects).
- **ChatGPT.** Settings › Personalization › Custom instructions on the web and the desktop
  app, Settings › Customize ChatGPT on iOS and Android: up to 5,000 characters on a paid
  plan, 1,500 on Free and Go
  ([custom instructions](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions)).
  The instructions reach every device; the server they describe does not. OpenAI's help
  center says a custom MCP server is added on ChatGPT on the web only (Plugins, the plus
  button, Add custom MCP server; Developer Mode is no longer a separate step), that full
  MCP, write actions included, is for Business and Enterprise/Edu workspaces, where an
  admin adds and publishes the server, and that a Pro account can connect a custom server
  for reading and fetching only. ChatGPT uses an app when it is picked for a message
  (type @ and choose it), so there the instructions shape what it does with Unbent more
  than whether it reaches for it. See
  [connecting custom MCP servers](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

**What no instructions can do.** No consumer chat app runs anything after a conversation:
neither Claude nor ChatGPT has a hook that fires when a chat ends, so "keep your own notes
as you go" would depend on the model choosing, mid-conversation, to call a tool. The
instructions do not ask for it: what comes up in conversation is the assistant's own
memory's to keep, and Unbent gets what the person files. And every platform asks before an assistant writes until it is trusted: Claude
shows an approval prompt for each tool until Allow always is chosen for it, and ChatGPT
asks for write actions according to the app's permissions and the action. What does hold
is Unbent's own side of it: everything an assistant writes is a plain note, kept in the
note's history as the assistant's, and nothing it can do deletes a note for good.

### Skills

A skill is a set of instructions Claude loads when a request matches it, for a filing job
repeated often enough to be worth spelling out. Three are published here as examples:

- [unbent-log](assistants/skills/unbent-log/SKILL.md) logs a rated meal, drink or
  anything else from a terse line ("Acme Diner, mushroom risotto, 4 stars, yes") into
  whichever notebook has a Date and a Rating field, and answers questions about past
  entries.
- [watch-later](assistants/skills/watch-later/SKILL.md) adds a film or series to a Watch
  Later notebook from a Letterboxd link, checking for a duplicate first.
- [add-to-wishlist](assistants/skills/add-to-wishlist/SKILL.md) adds a product to a
  Shopping notebook from its link, with the product's image attached.

Each states the notebook and fields it expects at the top, and is meant to be edited to
match the library it is used with. To install one in Claude, zip its folder (the folder
itself, so the archive's root is the skill's directory) and upload it under Customize ›
Skills, Add. Skills need code execution turned on. See
[custom skills](https://support.claude.com/en/articles/12512198-how-to-create-custom-skills).

```bash
cd docs/assistants/skills && zip -r unbent-log.zip unbent-log
```

In Claude Code, copy the folder into `~/.claude/skills/` instead.
