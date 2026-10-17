# Sync and offline

## Your library on the device

The installed app (and the Android app, which is the site in a WebView) opens with no
signal and works. A service worker keeps the app itself on the device, and your library
lives there too: the notes, notebooks and tags of the signed-in account, in a SQLite file in
the browser's private storage, copied from the server the first time you sign in on a device
(a line across the top counts the notes as they arrive, and a copy interrupted by closing the
app picks up where it stopped) and kept current by the change feed
after: on open, when you come back to the tab, and the moment another device saves,
through a socket that says only that something changed. A warm open draws the list with no
request at all. One tab or window holds the library file at a time, and every other tab
of the same account works through it (reading the same copy, saving into the same queue,
offline included) so nothing tells them apart. Settings → Offline says which tab holds
the file and moves it to the one you are in with one press.

Edits land on the device first. A note you write, make, file, tag, trash or restore with
no connection is saved here at once (the note head says "Saved", with a small cloud
beside it until the server has the note too) and goes to the server, in order, when the
connection returns. A save that would overwrite
an edit made on another device meanwhile is refused there and put to you as before: reload
theirs, or keep yours on top of it. What needs the server now says so and waits:
Auto-fill, and the settings pages that manage notebooks, tags and fields. A lost connection
is never taken for signing out.

Search works without a connection too. The device keeps an index of its own beside the
library (the same FTS5, stemmer and ranking the server uses, in the SQLite the library
already runs in the browser) over
every note's title, body, tags and field values, and with no connection the search box asks
it instead: the same results, the same filters. The text inside files is the exception. It
is the largest thing an account stores after the files themselves, so a device holds it
only for the notebooks it keeps offline and for the last five hundred notes opened on
it (up to about 20 MB of text between them, newest first), and a line under the results says when a search was answered on the device and how many
files' text it could not see: "No matches" offline should never be read as "not in your
notes". When the connection returns the same search is asked of the server, and its answer
replaces the device's in place.

Files are the bulk of an archive, so they are on the device by choice rather than by
default. A file you open is kept, within a budget: 500 MB, the ones opened longest ago
going first. A notebook can be kept whole: its page offers **Keep offline**, says how big
that is and how much room the device has before it starts, and from then on fetches the
notebook's files, including ones added later from another device. A file added to a note
with no connection is held on the device, shown in the note at once, listed as waiting, and
uploaded when the connection returns. A file that is not on the device says "Not available
offline" where it would be drawn. Settings → Offline shows what the device is holding and
gives the room back.

Signing out removes the library and its files from the device, as does deleting the account
or another person signing in. A sign-in that has expired does not: your copy stays, closed, and signing
in again reopens it and sends whatever you changed while it waited. The rules the code is
held to are in `apps/web/src/store/` and AGENTS.md.

## Local database

`pnpm --filter @unbent/api db:reset` rebuilds the local D1 from migrations and clears the
local note stores, copying both into `.wrangler/backups/` first. Use it instead of removing
the state directory by hand: that has no undo and has already cost one set of local notes.
The two go together: local notes live in Durable Objects under `.wrangler/state/v3/do/`,
keyed by the user ids in D1, and resetting one without the other leaves ghost objects
behind: notes with no account, or a fresh account whose first open finds an object already
holding someone's earlier state.
