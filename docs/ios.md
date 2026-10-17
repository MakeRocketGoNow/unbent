# iOS app

The site, whole, in one web view, the way the Android app is, with native code only for
what a page cannot do on an iPhone: sign-in, saving files where the phone keeps them, links
that leave, and the app's own address and version. It is a port of the Android app's shell
rather than a second design, and where the two differ it is because the platforms do.
TestFlight is still to come.

```
swift test --package-path apps/ios/Packages/UnbentCore   # unit tests, on the Mac, no simulator
pnpm ios:build      # build, install and launch the debug build on a simulator
pnpm ios            # launch what is already installed
```

**How it is laid out.** `apps/ios/Unbent.xcodeproj` has two targets, the app and its Share
Extension, whose sources are the `Unbent/` and `UnbentShare/` folders as they are on disk,
with `Shared/` compiled into both; a file added to any of them needs no change to the
project. Two local Swift packages hold everything that is not the shell or a sheet of the
system's. `UnbentCore` is Foundation
only and builds for the Mac, which is what lets its tests run without a simulator: the
session cookie, where an address opens, the API, the Keychain store, the page's messages
and the files the app saves, each a port of the Kotlin one with its tests. `UnbentUI` is
the native screens as SwiftUI views that take values and closures, apart from the app so
the share extension can draw the same ones.

Every build setting is in `apps/ios/Config/` (`Base.xcconfig`, with `Debug.xcconfig` and
`Release.xcconfig` over it, and `Share.xcconfig` for what the extension's build differs
in) and the project file holds none. `Info.plist` reads them, and
`BuildInfo.swift` reads `Info.plist`. The plist is run through the C preprocessor for the
two blocks only the debug build has, which is why it has no DOCTYPE and no apostrophes: the
preprocessor takes `//` for a comment and a lone `'` for an unfinished character.

The debug build is a second app, as on Android: bundle id `.debug`, the name "Unbent
(debug)", an amber icon, and its own session and web data, so the two sit side by side.

**How it signs in.** By what the instance offers, read from `GET /api/config`. Two methods
are only requests: a code by email and a password, against Better Auth directly. Three put
one of the system's sheets first. Apple's, which returns an identity token bound to a
nonce: Apple is given the nonce's SHA-256 and the server the nonce itself, and the name
Apple sends on a first authorization is set on the account afterwards. The passkey sheet,
which signs the challenge from `/api/auth/passkey/generate-authenticate-options`; the
cookie that response sets names the challenge and is sent back with the answer by hand,
since the app's client keeps no cookie jar. And a browser at `/connect`
(`ASWebAuthenticationSession`, sharing Safari's cookies) for Google and for any other
provider the instance has, which comes back on `unbent://connect` with a one-time token,
the Android app's flow, and the same two redirect schemes, since a scheme belongs to one
platform's install. Google has no sheet of its own here: Google's SDK would be a
dependency that ends in a web sheet anyway. Passkeys need the app to claim the instance's
host (`webcredentials:` in `Config/Unbent.entitlements`) and the instance to vouch for the
app, below; the debug build claims `dev.unbent.app` too, in developer mode, and a dev
server on localhost cannot be claimed at all. Every path ends the same way as on Android:
the session cookie the response set is kept per origin, here in the Keychain under the App
Group so the share extension can read it, and is `AfterFirstUnlockThisDeviceOnly`: usable
while the phone is locked in a pocket, and never restored onto another phone. Its value
goes out as `Authorization: Bearer` from the app's own client, and the same cookie is put
into the web view's store before every load. `URLSession` hands a response's `Set-Cookie`
headers over joined into one, so they are split apart again before the session is looked
for; `SessionCookie.splitSetCookie` says why `HTTPCookie` is not used for that.

Signing out on the page tells the app, which forgets its copy and shows its own sign-in. A
page that believes the session has ended says so too, and the app asks `/api/me` before
believing it; a phone with no signal gets a native "Couldn't reach Unbent" panel and keeps
the session.

**How the site is hosted.** `WebShellController` is one `WKWebView` of the instance, and
the page has the whole screen. It did not at first: the page was held inside the safe
area with the strips above and below painted in its colour, as on Android, and on a phone
with a Dynamic Island those strips are tall enough that the drawer and its scrim stopped
short of both ends of the screen and read as a card between two bands. So inside the iOS
app the page asks for `viewport-fit=cover`, keeps its own content clear of the clock and
the home indicator with `env(safe-area-inset-*)` (the rules under `html.host-ios` in
`styles.css`), and tells the app it has done so; a page that has not said so, from an
older deploy, still gets the safe area and the strips. The drawer is square-cornered
there as well, since the rounded one is Material's shape and iOS side panels are not. The
status bar's text follows the lightness of the colour the page reports. The keyboard
shrinks the web view rather than covering it, so the editor's toolbar sits on the keys. The bridge is a script the app
injects before the page's own, which builds `window.UnbentApp` over WebKit's message
handlers (the object Android installs with `addJavascriptInterface`) so the page calls
either host the same way (`apps/web/src/app-bridge.ts`, `Bridge.swift`). There is no Back to
handle: the edge swipe walks the web view's history, and the page closes a sheet when the
history moves under it.

Links off the site, `target=_blank` included, open in a Safari sheet over the app; a new
window to the site itself opens in place, without reloading the page. Downloads run in the
web view's own session and are saved into the app's folder, which the Files app shows under
On My iPhone; an export is built in the page and streamed through the bridge's save calls,
each answered only once its bytes are written, which is what keeps a library larger than
memory from queueing there. Both are written to a hidden file and named once whole, and a
banner offers to open or share what was saved. `alert`, `confirm` and `prompt` are shown by
the app, because a web view left to itself answers `confirm()` with false and asks nobody.
The file picker and the camera need no code: WebKit presents its own for a file input, and
a photo chosen from the library arrives as a JPEG even when the phone took it as HEIC, so
the transcoding the Android app does by hand is not needed for those. A HEIC picked through
Choose Files is handed over as it is.

**Why a build opens one instance.** WebKit gives an app's web view a service worker (and
so the offline shell, see [Your library on the device](sync-and-offline.md#your-library-on-the-device)) only
for the domains the app binds itself to, in `WKAppBoundDomains`, and a web view bound that
way can open nothing else. So a release build opens the instance it was built for and App
settings shows the address without a field; a self-hoster builds the app for their own
host, below. The debug build is
also bound to `dev.unbent.app` and `localhost`, and its App settings can switch among them.
With the instance stopped, the app relaunches into the note list from the service worker
and the local copy, with the page's own offline banner.

What the page stores survives relaunching the app and restarting the phone: the cookie,
the outbox in IndexedDB, and the library in the origin-private file system.
`navigator.storage.persist()` answers false in the web view, so that storage is the
system's to reclaim under pressure, like any app's caches; nothing the server has not heard
of is kept only there for long, since the outbox drains whenever there is a connection.

**How a capture is saved.** Sharing to Unbent from another app opens the extension's
sheet (title, notebook, tags, prefilled as on Android) over a copy of what was shared,
made in the App Group's container before the sheet has drawn (`CaptureStager`): what a
share hands over lasts only as long as the sheet. A HEIC with no JPEG offered beside it
is transcoded, since the server serves HEIC to nobody inline.

Nothing is uploaded by the extension, or by the app in the ordinary sense. iOS ends an
extension when its sheet closes and suspends the app seconds after it leaves the screen,
so every request is handed to a background `URLSession`, which the system sends whether or
not anything of the app's is running, launching the app in the background to hear each
result (`CaptureQueue`). A background session promises no order, so the requests go a stage
at a time: Save sends `POST /api/notes` and closes the sheet, and the files follow once
the note is known to exist. Each result is applied to the capture's record, `.job.json`
beside its files, by a pure function with the rules in it (`CaptureJob.handle`): four
tries with a backoff, and none for a 4xx that will be the same next time; a file given up
on is left out of a capture that is otherwise saved; a 503 with `Retry-After` waited
out, up to fourteen times, without spending a try; a 401 for the session the phone still
holds forgets the session and keeps the capture, which then waits for a sign-in like one
made signed out. A retry is a request created at once with `earliestBeginDate`, so the
wait is the system's to keep. The note's id is chosen on the phone, and each file's is
sent as `X-Attachment-Id`, which is what makes any of this safe to send twice. An app the
person force-quit is not relaunched for a result, so whatever is on disk is also looked
at on every launch and every return to the app.

The app has one background session; the extension has one per capture, named in the
capture's record, which the app joins to collect what the extension started. Only one
process may use a background session at a time, and a single shared name has a second
share contending with the app woken for the first.

Shared while signed out, a capture is staged all the same and sent after the next sign-in;
it waits thirty days for one, and the notification says so if it is given up on. A sheet
closed without Save or Cancel leaves no record, and its files go after three.
Its one notification goes from "Saving…" to "Saved" in place and opens the note; delivery
is asked for provisionally, so there is no prompt and the first one arrives quietly with
the system's own Keep or Turn Off. A PDF or an image can also be opened in the app from
another one ("Open in", Files, a scanner's app), which shows the same sheet over the same
queue. Captured PDFs are not indexed on the phone, as Android's are: the server's own
extraction covers unbent.app, and the site's pass when the note is opened covers the rest.

**What iOS does that Android does not.** It suspends an app seconds after it leaves the
screen, so the shell asks for a few seconds of background time for the page's save on
`visibilitychange` to reach the server. It ends the page's process under memory pressure
while the app lives on, which leaves a blank web view that says nothing; the shell is told,
drops any export that page was writing, and reloads the address it was on. And it can
empty the cookie store between two looks at the app, so the session is put back each time
the app comes forward as well as before each load.

**Pointing it at a dev server.** In the debug build, App settings takes
`http://localhost:<port>`; a simulator shares the Mac's loopback, so nothing like `adb
reverse` is needed. Plain http is allowed for local addresses in debug builds only
(`NSAllowsLocalNetworking`). Vite's port serves the site without its service worker; the
Worker's own port serves the built site with it, after `pnpm build`.

**Building it for your own instance.** Put the three things that are yours in
`apps/ios/Config/Local.xcconfig`, which is untracked and read last:

```
UNBENT_BUNDLE_ID_BASE = com.example.notes
UNBENT_INSTANCE_HOST = notes.example.com
DEVELOPMENT_TEAM = ABCDE12345
```

The first is the identity the App Store, the App Group and the site association document
all key on, and has to be a reverse-domain name you control. The second is the instance the
app opens and the one domain its web view is bound to; `UNBENT_INSTANCE_SCHEME` beside it
is `https` unless you say otherwise, and the two are apart because `//` begins a comment in
that file. The third signs a build for a phone; a simulator needs none. `MARKETING_VERSION`
and `CURRENT_PROJECT_VERSION` are the version and build number App settings shows.

**Links and quick actions.** A link to the instance's notes, trash or settings, tapped in
Mail, Messages or Safari, opens in the app (a universal link), at the same place on
whichever instance the app is pointed at. The app claims the host (`applinks:` in the
entitlements); which paths are the app's is the instance's to say, in the association
document below, and a link to a host the app is not pointed at now opens in Safari's sheet
over it. Held on the Home Screen, the icon offers New note and App settings. New note opens
`/notes?new=1`, which the site answers as its New button: it makes an unfiled note and
replaces the address, so Back and a reload do not make another. The debug build claims
`dev.unbent.app` in developer mode, which a simulator always is, so
`xcrun simctl openurl booted https://dev.unbent.app/notes/<id>` tries it; the first link
after an install can still open in Safari, while the system is fetching the document.

A store build cannot do either for an instance of your own: universal links and passkeys
offered by the system both go to the host the build claims, and the store build claims
unbent.app. Build your own, as above, with `UNBENT_INSTANCE_HOST` set to your host, and serve
an association document naming it.

**Vouching for the app.** iOS opens this site's links in the app (universal links), and
offers the site's passkeys to it, only if the site says which app that is: an Apple App
Site Association document at `/.well-known/apple-app-site-association`, naming each app by
its team id and bundle id. The instance serves it from its `APPLE_APP_SITE_ASSOCIATION`
secret (the JSON verbatim, an object rather than Android's array) and an instance that
has not set one vouches for no app. The team id is on the Apple Developer portal's
Membership page; the debug build is a different bundle id (`.debug`) and is listed beside
the release one.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.com.example.notes", "TEAMID.com.example.notes.debug"],
        "components": [
          { "/": "/connect", "exclude": true },
          { "/": "/api/*", "exclude": true },
          { "/": "/notes" }, { "/": "/notes/*" },
          { "/": "/trash" }, { "/": "/trash/*" },
          { "/": "/settings" }, { "/": "/settings/*" }
        ]
      }
    ]
  },
  "webcredentials": {
    "apps": ["TEAMID.com.example.notes", "TEAMID.com.example.notes.debug"]
  }
}
```

The paths are the Android app's: the pages, never the sign-in flow or files. The first
component that matches wins, so the exclusions come first, and `/notes/*` rather than
`/notes*` keeps a path that merely starts with the word from being claimed.

```bash
cd apps/api
pnpm exec wrangler secret put APPLE_APP_SITE_ASSOCIATION < apple-app-site-association.json
```

Apple's CDN fetches the document, not the phone, so it has to reach the Worker from a
datacenter: a zone with Bot Fight Mode on needs a WAF skip for `/.well-known/` paths, or
the CDN is served a challenge. `https://app-site-association.cdn-apple.com/a/v1/<your
host>` shows what Apple has. The `APPLE_APP_SITE_ASSOCIATION` repository secret carries the
same document to the dev instance and previews.

**Sign in with Apple from the app.** The app signs in natively and posts Apple's identity
token to `/api/auth/sign-in/social`, as the Android app does with Google's. That token's
audience is the app's bundle id, not the Services ID the web button uses, so an instance
accepts it only for the bundle ids in `APPLE_BUNDLE_ID` (comma-separated, the release and
the debug build both, since either may be pointed at any instance):

```bash
echo "com.example.notes,com.example.notes.debug" | pnpm exec wrangler secret put APPLE_BUNDLE_ID
```

It is read only while Apple is configured for the web too (see [Sign in with
Apple](self-hosting.md#sign-in-with-apple)): the Services ID is still accepted beside it, and an instance
without `APPLE_CLIENT_ID` offers Apple to nobody. Both App IDs need the Sign in with Apple
capability on the portal.
