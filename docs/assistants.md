# Connecting an AI assistant

Unbent is an [MCP](https://modelcontextprotocol.io) server, so Claude, Cursor, ChatGPT or
anything else that speaks the protocol can work with your notes directly. The server URL is
`https://unbent.app/api/mcp`: no trailing slash, and no API key to copy anywhere.

Connecting runs the ordinary OAuth flow: the client registers itself, a browser opens on the
consent screen, and approving it hands the client a token of its own. The tools cover
search and list, reading a note in full, create, edit, tag, move, trash and restore (create
and the last four for several notes at once), attaching a file, and notebook management. Note bodies are Markdown and pass whole in both
directions, so an assistant writes a complete note in one call.

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
