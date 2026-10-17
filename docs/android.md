# Android app

The site, whole, in one WebView, with native code only for what a page cannot do on
Android: the share sheet, sign-in through the phone's account sheet, the file picker and
camera, saving into Downloads, links, and the app's own address and version.

It used to draw its own note list, filters, notebooks, trash and settings in Compose, with
only a note's body in a WebView. Every feature the site gained then had to be built twice,
and within a week the phone was missing bulk selection, auto-fill and half of what
Settings does. The site is held to a phone-layout standard anyway, so the app shows it. A
self-hosted instance serves the app the site that matches its API, and a change to the site
reaches the phone on deploy, with no store release.

```
cd apps/android
./gradlew test              # unit tests, no device needed
./gradlew installDebug      # build and install on a running emulator or device
```

The build needs a `local.properties` naming the SDK, which Android Studio writes for you:

```
sdk.dir=/Users/you/Library/Android/sdk
```

**How it signs in.** By whatever the instance offers, read from `GET /api/config`: Google
through Android's account sheet, GitHub through a Custom Tab to `/connect` that comes back
with a one-time token, or email and password against Better Auth directly. Where the
instance checks a Turnstile token with the request for a sign-in code, the app first loads
the instance's `/turnstile` page in a WebView it keeps off screen (`TurnstileChallenge.kt`),
which mints the token through the bridge and is shown only if the widget wants a tap. Every
path ends the same way: the session cookie the response set is stored per origin in app-private
preferences. Its value goes out as `Authorization: Bearer` from the app's own client, and
the same cookie is written into the WebView's jar before the site loads: one sign-in,
one session, nothing exchanged between the two. A Trusted Web Activity could never do
this, because Chrome's cookie jar is Chrome's; that is why the previous shell needed a
handoff on every launch. Signing out on the page tells the app, which forgets its copy and
shows its own sign-in. A page that believes the session has ended says so too, and the app
asks `/api/me` before believing it, because a phone with no signal looks the same to the
page; that case gets a native "couldn't reach" panel and keeps the session.

**How the site is hosted.** `MainActivity` is one WebView of the instance. The page sits
between the system bars, and the app paints the strips behind them in the page's own
colour, which the page reports; the keyboard shrinks the page, so the editor's toolbar sits
on the keys. A small bridge (`apps/web/src/app-bridge.ts`, `NoteBridge.kt`) carries
everything else. Back asks the page first, which closes an open sheet, then walks the
WebView's history, then puts the app in the background rather than finishing it, so an
upload in flight and the page's state survive. A notification's note opens in place
without reloading the site. The site's Settings shows an "App settings" pill only inside
the app, for the native screen that holds the instance address and version; the launcher
icon's long-press reaches it too.

Links off the site, `target=_blank` included, open in a Custom Tab. Attachment downloads
go to DownloadManager with the session added by hand, since it cannot see the WebView's
cookies. An export is built in the page (see [Backups and export](backups.md#backups-and-export))
and streamed to the app through the bridge's synchronous save calls, which write it into
Downloads as it arrives. A `blob:` download would reach the download manager as an address
only the page can read, and the export would silently save nothing. Links to the
instance's `/notes`, `/trash` and `/settings` open in the app through verified App Links,
rebased onto whichever instance the app points at; the rest of the host, `/connect` and
mailed links above all, stays in the browser.

**How a file is attached.** The Attach button is the editor's own, in its bar; what the
app adds is the file chooser behind it, since a WebView opens no picker of its own. It
offers the phone's file apps with the camera beside them, the way Chrome answers the same
input, and an input that asks for capture goes straight to the camera. The picker's files
go to the page as they are, under the picker's grant. A photo the camera takes is written
to the app's cache and handed over through a FileProvider, accepted by identity because the
chooser otherwise refuses this app's own provider. A HEIC photo is transcoded to JPEG on
the phone first, for the reason given under captures below.

**How a capture works.** Sharing to Unbent opens a sheet over the sending app with the
title, the notebook and the tags, prefilled so that the lazy case is one tap on Save. The
shared files are copied into the app's cache the moment the sheet opens (the URI
permission dies with the activity, so this cannot wait), which is also what lets someone
who is signed out sign in and come back to find the share still there. Save enqueues a
WorkManager job that creates one note, filed and tagged as the sheet said, and streams
each file to `PUT /api/notes/:id/files?link=1`. The `link=1` flag is what makes the server
append the markdown link to the note body, since the sheet has no cursor and no copy of
the body. Several files shared together become one note. A toast says "Saving" as the sheet
closes, and the capture's progress is a notification, since a toast cannot change or be
tapped: "Saving" with the note's title, then "Saved", which peeks over the screen and opens
the note in the app. HEIC images are transcoded to JPEG on the phone, because the server's inline-safe
allowlist excludes HEIC and browsers other than Safari cannot render it.

**How a capture becomes searchable.** A PDF gets a second job, chained after the upload:
it loads `/embed/index-files?note=…` in a WebView that is never shown, and the page runs
the same pdf.js extraction the site does, for that one note. Chained rather than folded
into the upload so a WebView failure can never re-run the upload and create the note
twice; photos have no text and skip it. When the server extracted the text itself as the
files landed, the upload says so and the second job ends without opening a WebView. If it
fails, the note is still saved and the file stays on the server's pending list, where the web
app's pass on open picks it up.

**Pointing it at a dev server.** On the sign-in screen, Change the address to
`http://10.0.2.2:5173` from an emulator; once signed in the same field is in App settings.
Cleartext is permitted for loopback addresses in debug builds only (see
`network_security_config.xml`), and the API trusts that origin in development (see
`baseURLFor` in `apps/api/src/auth.ts`).

**Release signing.** The keystore lives outside the repo. Point at it from
`apps/android/local.properties`:

```
unbent.keystore.path=/Users/you/.config/unbent/release.jks
unbent.keystore.password=…
unbent.key.alias=unbent
unbent.key.password=…
```

Absent those, `assembleRelease` still builds, just unsigned. CI reads the same values from
`UNBENT_KEYSTORE_PATH` and friends.

**Building it for your own instance.** Two more lines in the same file, neither of which
touches a tracked file:

```
unbent.defaultInstance=https://notes.example.com
unbent.applicationId=com.example.notes
```

The first is where the app signs in until someone changes it in App settings; unset, it is
`https://unbent.app`. Its host is also the one the app claims links on. The second is the identity Play, the Google OAuth client and the app
links document all key on, and a fork that publishes needs one of its own: Play will not
take a second app under an id it already has, and a reverse-domain id has to be one you
control. The Kotlin package stays `com.makerocketgonow.unbent` either way; only the id
changes, and `scripts/app-id.sh` prints what a build of this checkout gets. CI reads the
same two as the `ANDROID_DEFAULT_INSTANCE` and `ANDROID_APPLICATION_ID` repository
variables, and the Play upload publishes under the same id.

**Vouching for the app.** Android will only open this site's links in the app, and only
offer the site's passkeys to it, if the site says which app that is: a Digital Asset Links
document at `/.well-known/assetlinks.json` naming the package and the SHA-256 of every
certificate that signs it. The instance serves that document from its `ANDROID_ASSET_LINKS`
secret (the JSON verbatim, an array of statements) and an instance that has not set one
vouches for no app, which is right until you have one. The debug build is a different
package (`.debug`) and needs a statement of its own. Three keys usually sign a published
app, and all three belong in it: the debug keystore, the upload key, and the App Signing
key Play re-signs every bundle with, whose fingerprint is on the app's App signing page in
Play Console. Registering only the upload key is the classic trap, because every build you
can test locally then works and the store build does not.

```bash
cd apps/api
pnpm exec wrangler secret put ANDROID_ASSET_LINKS < assetlinks.json
```

The `ANDROID_ASSET_LINKS` repository secret carries the same document to the dev instance
and previews, so passkeys made there work from the app too.
