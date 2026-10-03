import os
import SwiftUI
import UIKit
import UnbentCore
import UnbentUI
import WebKit

protocol WebShellDelegate: AnyObject {
    /// The session is over: the person signed out on the page, or the server no longer
    /// knows it.
    func shellDidSignOut(_ shell: WebShellController)

    /// The page, or the unreachable panel, asked for the app's own settings.
    func shellWantsSettings(_ shell: WebShellController)
}

/// The site, in one web view.
///
/// The page and the app talk over the bridge in apps/web/src/app-bridge.ts (`Bridge`): the
/// page asks for the app's settings, reports a sign-out or a session it thinks has ended,
/// and says what colour it is; the app asks the page to open a note in place.
///
/// What is different from Android (`MainActivity.kt`) is what iOS does to an app behind
/// the person's back. It suspends the app seconds after it leaves the screen, so the page
/// is given a moment to finish saving (`enteredBackground`). It kills the page's process
/// under memory pressure while the app itself lives on, leaving a blank view that has to
/// be noticed and reloaded (`webViewWebContentProcessDidTerminate`). And it can empty the
/// cookie store between two looks at the app, so the session is put back every time the
/// app comes forward and before every load (`installSession`), not once.
///
/// There is no Back to handle: iOS has no such button, and the edge swipe walks the web
/// view's own history, which the page listens to (MAK-150 made a sheet close when the
/// history moves under it).
final class WebShellController: UIViewController {
    weak var delegate: WebShellDelegate?

    private let origin: String
    private let sessions: SessionStoring
    private var startPath: String?

    private var webView: WKWebView!
    private let folder = SavedFiles.downloads()
    /// Made in `init`, not lazily: `deinit` aborts whatever is still open, and a lazy one
    /// first touched there would be built — weak reference to the shell and all — by an
    /// object already being freed, which the runtime answers by ending the app. Signing
    /// out without ever having exported did exactly that.
    private let saves: SaveStreams
    private let kept = Kept()

    /// How a finished export finds its way back to a shell it must not keep alive.
    private final class Kept {
        var announce: ((URL) -> Void)?
    }

    /// Every save call runs here, one at a time, and is answered from here: a page writing
    /// faster than the phone's storage waits on each answer instead of queueing the
    /// library in memory. See `SaveStreams`.
    private let saveQueue = DispatchQueue(label: "unbent.saves")

    /// Where each download in flight is being written, and what to call it once whole.
    private var downloads: [ObjectIdentifier: (partial: URL, name: String)] = [:]

    /// The page's ground, as the page reported it; the launch colour until it has.
    private var ground: UIColor = .unbentGround
    private var groundIsDark: Bool?

    /// The site could not be reached; a native panel says so instead of an empty view.
    private var unreachable: UIViewController?

    /// Whether the load in progress failed. A 5xx is reported before the server's error
    /// page commits, and that commit must not take the panel down again.
    private var failed = false

    private var checkingSession = false
    private var banner: UIViewController?
    private var bannerTimer: Task<Void, Never>?

    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "unbent", category: "shell")
    private let pageLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "unbent", category: "page")

    private static let home = "/notes"

    init(origin: String, sessions: SessionStoring, startPath: String?) {
        self.origin = origin
        self.sessions = sessions
        self.startPath = startPath
        saves = SaveStreams.files(in: folder) { [kept] url in
            // Kept on the save queue; the banner is the main thread's.
            DispatchQueue.main.async { kept.announce?(url) }
        }
        super.init(nibName: nil, bundle: nil)
        kept.announce = { [weak self] url in self?.saved(url, canOpen: false) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not in a storyboard") }

    deinit {
        // An export still streaming has lost the page that was writing it.
        saves.abortAll()
        bannerTimer?.cancel()
    }

    // MARK: - The view

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ground

        let webView = WKWebView(frame: .zero, configuration: configuration())
        self.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // A long press on a link would otherwise open a Safari preview of a page of the
        // app, inside the app.
        webView.allowsLinkPreview = false
        // Painted before the first frame, so dark mode does not open on a white flash,
        // and showing through when the page is pulled past its end.
        webView.isOpaque = false
        webView.backgroundColor = ground
        webView.underPageBackgroundColor = ground
        webView.scrollView.backgroundColor = ground
        // The view is already inside the safe area; a second inset from the scroll view
        // would push the page down by a status bar it is not under.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif

        /*
         * The page is kept out from under the status bar and the home indicator, and the
         * strips behind them are this view's background, painted in the page's own colour.
         * A page told nothing about the safe area cannot lay itself out around it, and the
         * site is not asked to learn (`index.html` has no `viewport-fit=cover`) — in the
         * page's colour the strips read as the page running to the edge.
         *
         * The keyboard shrinks the web view instead of covering it, so the editor's docked
         * toolbar sits on the keys: `keyboardLayoutGuide` is the safe area's bottom when
         * there is no keyboard and the keyboard's top when there is. Because the view no
         * longer overlaps the keyboard, WebKit has nothing to inset and the page's own
         * `useKeyboardInset` reads zero, so the toolbar is lifted once, not twice.
         */
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])

        let path = startPath ?? Self.home
        startPath = nil
        load(path: path)
    }

    private func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        // The persistent store: the session's cookie, the service worker and the local
        // copy of the library all have to be there at the next launch.
        config.websiteDataStore = .default()
        /*
         * App-Bound Domains. With the hosts listed in Info.plist and this set, WebKit lets
         * the site register its service worker — the offline shell — and lets the app
         * inject its bridge. The price is that this web view cannot open any other host,
         * which is the rule here anyway. A build with no list (see `BuildInfo`) leaves it
         * off: the bridge and cookies still work, and there is no service worker.
         */
        config.limitsNavigationsToAppBoundDomains = BuildInfo.appBoundHosts != nil
        // Replaces the trailing "Mobile/…" token; the server logs the user agent, and this
        // is what tells the app from Safari there.
        config.applicationNameForUserAgent = "UnbentiOS/\(BuildInfo.version)"
        config.allowsInlineMediaPlayback = true

        let handler = WeakMessageHandler(self)
        let content = config.userContentController
        content.addUserScript(Bridge.script)
        content.add(handler, name: Bridge.messages)
        content.addScriptMessageHandler(handler, contentWorld: .page, name: Bridge.saves)
        #if DEBUG
        content.addUserScript(Bridge.logScript)
        content.add(handler, name: Bridge.log)
        #endif
        return config
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        // The panel stands on the theme's own ground, which the system's style already suits.
        guard unreachable == nil, let groundIsDark else { return .default }
        return groundIsDark ? .lightContent : .darkContent
    }

    private func setGround(_ colour: PageColour) {
        ground = UIColor(red: colour.red, green: colour.green, blue: colour.blue, alpha: 1)
        groundIsDark = colour.isDark
        view.backgroundColor = ground
        webView.backgroundColor = ground
        webView.underPageBackgroundColor = ground
        webView.scrollView.backgroundColor = ground
        setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: - Loading

    /// Puts the session in the web view's cookie store, then runs `then`.
    ///
    /// Before every load rather than once: the store can be emptied behind the app's back,
    /// and a fresh sign-in replaces the session. Setting the same cookie again is a no-op,
    /// so the cost of being safe is nothing.
    private func installSession(then: @escaping () -> Void = {}) {
        guard let cookie = sessions.session(for: origin)?.httpCookie(origin: origin) else { return then() }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie, completionHandler: then)
    }

    private func load(path: String) {
        guard let url = URL(string: origin + path) else { return }
        installSession { [weak self] in
            self?.webView.load(URLRequest(url: url))
        }
    }

    /// Goes to `path` on the site. In place when a page is up to ask, so a link opened
    /// while the app is showing a note does not reload the site under an upload in flight;
    /// by loading it when the page cannot answer — still loading, or a deploy from before
    /// `open`.
    func open(path: String) {
        guard isViewLoaded else {
            startPath = path
            return
        }
        webView.evaluateJavaScript(Bridge.ask("open&&u.open(\(Bridge.quote(path)))")) { [weak self] result, _ in
            if result as? Bool != true { self?.load(path: path) }
        }
    }

    /// The app came forward. The cookie store may have been emptied while it was away.
    func becameActive() {
        guard isViewLoaded else { return }
        installSession()
    }

    /// The app left the screen, and iOS will suspend it within seconds. The page saves on
    /// `visibilitychange`, which fires now; asking for a little background time is what
    /// lets that request reach the server instead of being frozen half-sent. (The edit is
    /// not lost either way — it is in the local copy and the outbox — but a note that
    /// reaches the server now is a note the other devices have.)
    func enteredBackground() {
        let app = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        let end = {
            guard task != .invalid else { return }
            app.endBackgroundTask(task)
            task = .invalid
        }
        task = app.beginBackgroundTask(withName: "unbent.flush", expirationHandler: end)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: end)
    }

    // MARK: - The session

    /// Whether the page is right that the session has ended, before acting on it.
    ///
    /// The page cannot tell a session the server no longer knows from a phone with no
    /// signal: both leave it without a user, and both send it to its sign-in page and say
    /// `unauthorized`. Signing out on the second would throw away a good thirty-day
    /// session because of a tunnel. So the app asks the server itself: no user, or a 401,
    /// is a real sign-out; anything else is the network, which gets the unreachable panel
    /// and keeps the session for when it comes back. A session the server still honours
    /// sends the page back to where it was bounced from.
    private func checkSession() {
        guard !checkingSession else { return }
        guard let session = sessions.session(for: origin) else {
            delegate?.shellDidSignOut(self)
            return
        }
        checkingSession = true
        Task { @MainActor [weak self, origin] in
            let user: MeUser?
            var refused = false
            var unanswered = false
            do {
                user = try await UnbentApi(origin: origin, bearer: session.bearer).me()
            } catch let error as ApiError where error.status == 401 {
                user = nil
                refused = true
            } catch {
                user = nil
                unanswered = true
            }
            guard let self else { return }
            self.checkingSession = false
            if unanswered {
                self.setUnreachable(true)
            } else if user == nil || refused {
                self.delegate?.shellDidSignOut(self)
            } else {
                self.load(path: returnPath(current: self.webView.url?.absoluteString, fallback: Self.home))
            }
        }
    }

    // MARK: - Unreachable

    private func setUnreachable(_ on: Bool) {
        if !on {
            guard let panel = unreachable else { return }
            unreachable = nil
            panel.willMove(toParent: nil)
            panel.view.removeFromSuperview()
            panel.removeFromParent()
            setNeedsStatusBarAppearanceUpdate()
            return
        }
        guard unreachable == nil else { return }
        let panel = UIHostingController(rootView: UnreachablePanel(
            canChangeAddress: BuildInfo.isDebug,
            onRetry: { [weak self] in self?.retry() },
            onSettings: { [weak self] in
                guard let self else { return }
                self.delegate?.shellWantsSettings(self)
            }
        ))
        unreachable = panel
        addChild(panel)
        panel.view.frame = view.bounds
        panel.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(panel.view)
        panel.didMove(toParent: self)
        setNeedsStatusBarAppearanceUpdate()
    }

    private func retry() {
        setUnreachable(false)
        let url = webView.url
        // A page that fell to the site's own sign-in while offline goes back where it was
        // bounced from, or the list; the session was checked before the panel was shown.
        if url == nil || url?.scheme == "about" || url?.path.hasPrefix("/login") == true {
            load(path: returnPath(current: url?.absoluteString, fallback: Self.home))
        } else {
            installSession { [weak self] in self?.webView.reload() }
        }
    }

    // MARK: - Leaving the web view

    /// Sends an address that was asked for in a new window where it belongs.
    ///
    /// Off the site that is Safari's sheet (or the mail app, the phone): a second web view
    /// would run that page with this app's session in it. On the site it is `open`, in
    /// place — the web view has no tabs, and loading the address would tear the page down
    /// along with unsaved edits and an upload in flight.
    private func route(_ url: String) {
        switch classify(origin: origin, url: url) {
        case .inApp:
            // A `blob:`, `data:` or `javascript:` address the page made is dropped on
            // purpose: it has no tab to go to. Nothing on the site opens one in a new
            // window; a feature that wants to should hand the app a path or a file.
            if let path = inAppWindowPath(origin: origin, url: url) { open(path: path) }
        case .browser(let address):
            guard let url = URL(string: address) else { return }
            present(SFSafari.controller(for: url), animated: true)
        case .other(let address):
            // Nothing at all when nothing handles it, rather than an error about a link.
            guard let url = URL(string: address) else { return }
            UIApplication.shared.open(url)
        }
    }

    // MARK: - Saved files

    private func saved(_ url: URL, canOpen: Bool) {
        var actions: [BannerAction] = []
        if canOpen { actions.append(BannerAction("Open") { [weak self] in self?.preview(url) }) }
        actions.append(BannerAction("Share") { [weak self] in self?.share(url) })
        showBanner("Saved \(url.lastPathComponent) to Files", actions: actions)
    }

    private func showBanner(_ text: String, actions: [BannerAction] = []) {
        hideBanner()
        let host = UIHostingController(rootView: SavedBanner(text: text, actions: actions) { [weak self] in
            self?.hideBanner()
        })
        host.view.backgroundColor = .clear
        // The banner sits inside the web view's frame, which is already clear of the home
        // indicator; a second allowance for it would float the banner a strip too high.
        host.safeAreaRegions = []
        host.sizingOptions = [.intrinsicContentSize]
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addChild(host)
        // Under the unreachable panel if that is up: the panel is the whole screen.
        if let panel = unreachable { view.insertSubview(host.view, belowSubview: panel.view) } else { view.addSubview(host.view) }
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
            host.view.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
        ])
        host.didMove(toParent: self)
        banner = host

        host.view.alpha = 0
        UIView.animate(withDuration: 0.2) { host.view.alpha = 1 }
        // Long enough to read a filename and reach for Share. Announced too, since a line
        // that appears and goes is otherwise nothing to someone who cannot see it.
        UIAccessibility.post(notification: .announcement, argument: text)
        bannerTimer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { self?.hideBanner() }
        }
    }

    private func hideBanner() {
        bannerTimer?.cancel()
        bannerTimer = nil
        guard let host = banner else { return }
        banner = nil
        host.willMove(toParent: nil)
        UIView.animate(withDuration: 0.2) {
            host.view.alpha = 0
        } completion: { _ in
            host.view.removeFromSuperview()
            host.removeFromParent()
        }
    }

    private func share(_ url: URL) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // An iPad shows this as a popover and refuses to without somewhere to point.
        sheet.popoverPresentationController?.sourceView = banner?.view ?? view
        present(sheet, animated: true)
    }

    private func preview(_ url: URL) {
        present(FilePreview.controller(for: url), animated: true)
    }
}

// MARK: - The bridge

extension WebShellController: WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    /// Whether a message came from the site's own page. The handlers are reachable from
    /// any frame of any page this web view shows, and only one of those is entitled to
    /// sign the app out or write a file.
    private func isOurs(_ message: WKScriptMessage) -> Bool {
        guard message.frameInfo.isMainFrame else { return false }
        let source = message.frameInfo.securityOrigin
        guard source.protocol == "http" || source.protocol == "https" else { return false }
        let port = source.port == 0 ? "" : ":\(source.port)"
        return classify(origin: origin, url: "\(source.protocol)://\(source.host)\(port)/") == .inApp
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isOurs(message), let text = message.body as? String else { return }
        if message.name == Bridge.log {
            pageLog.error("\(text, privacy: .public)")
            return
        }
        // Unknown types fall through every case: a page from a newer deploy may say
        // something this build has never heard of.
        guard let message = BridgeMessage.parse(text) else { return }
        if message.isSignedOut {
            delegate?.shellDidSignOut(self)
        } else if message.isUnauthorized {
            checkSession()
        } else if message.isAppSettings {
            delegate?.shellWantsSettings(self)
        } else if let colour = message.themeBackground.flatMap(PageColour.init(hex:)) {
            setGround(colour)
        }
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard isOurs(message), let call = message.body as? [String: Any], let op = call["op"] as? String else {
            return replyHandler(nil, "Not a save call.")
        }
        let id = call["id"] as? String ?? ""
        let saves = saves
        saveQueue.async {
            // Answered only once the work is done — for `chunk`, once the bytes are
            // written. That answer is the page's signal to send the next piece.
            let answer: Any?
            switch op {
            case "begin":
                answer = saves.begin(name: call["name"] as? String ?? "", type: call["type"] as? String ?? "")
            case "chunk":
                answer = saves.chunk(id: id, base64: call["data"] as? String ?? "")
            case "end":
                answer = saves.end(id: id)
            case "abort":
                saves.abort(id: id)
                answer = true
            default:
                answer = nil
            }
            DispatchQueue.main.async {
                if let answer { replyHandler(answer, nil) } else { replyHandler(nil, "Unknown save call.") }
            }
        }
    }
}

// MARK: - Navigation

extension WebShellController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }

        // A new window. Allowed through to `createWebViewWith`, which is where both this
        // and `window.open` end up, so there is one place that decides where they go.
        guard let frame = action.targetFrame else { return decisionHandler(.allow) }

        if action.shouldPerformDownload {
            // A `blob:` address belongs to the page, and the site streams its exports
            // through the bridge instead; one arriving here is refused as Android's is.
            return decisionHandler(url.scheme == "blob" ? .cancel : .download)
        }

        if classify(origin: origin, url: url.absoluteString) == .inApp {
            return decisionHandler(.allow)
        }
        // A frame inside the page never opens a browser or another app; only the person
        // tapping something at the top level does. A frame navigating off the site is
        // refused rather than shown.
        if frame.isMainFrame { route(url.absoluteString) }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let http = response.response as? HTTPURLResponse

        // The site answers every page with the app itself, so a main-frame failure worth
        // a panel is the server's own: a 5xx. A 4xx is a real page saying something.
        if response.isForMainFrame, let http, http.statusCode >= 500 {
            failed = true
            setUnreachable(true)
            return decisionHandler(.allow)
        }

        let attachment = http?.value(forHTTPHeaderField: "Content-Disposition")?
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
            .hasPrefix("attachment") ?? false
        guard attachment || !response.canShowMIMEType else { return decisionHandler(.allow) }
        decisionHandler(response.response.url?.scheme == "blob" ? .cancel : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        failed = false
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if !failed { setUnreachable(false) }
    }

    /*
     * Only failures to reach the server. A navigation that turns into a download, or one
     * this delegate cancelled, is reported here too, under WebKit's own error domain, and
     * showing a panel over a page that is still there because a file started downloading
     * would be a lie.
     */
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let error = error as NSError
        let unanswered = error.domain == NSURLErrorDomain && Self.unreachableCodes.contains(error.code)
        // The one WebKit error that belongs here: an address this build is not bound to,
        // which only a debug build's stored instance can be. Nothing loads, and App
        // settings — where the panel points — is where it is put right.
        let unbound = error.domain == WKErrorDomain && error.code == WKError.navigationAppBoundDomain.rawValue
        guard unanswered || unbound else { return }
        log.warning("Could not load the site: \(error.localizedDescription, privacy: .public)")
        failed = true
        setUnreachable(true)
    }

    private static let unreachableCodes: Set<Int> = [
        NSURLErrorNotConnectedToInternet,
        NSURLErrorCannotFindHost,
        NSURLErrorCannotConnectToHost,
        NSURLErrorTimedOut,
        NSURLErrorSecureConnectionFailed,
        NSURLErrorNetworkConnectionLost,
    ]

    /// The page's process died — out of memory on a huge PDF, or iOS reclaiming it while
    /// the app was in the background. The web view is left blank and says nothing; it has
    /// to be loaded again, on the address it was showing.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.warning("The page's process ended; reloading.")
        // An export the page was streaming has lost the page that was writing it.
        saves.abortAll()
        if webView.url != nil {
            installSession { webView.reload() }
        } else {
            load(path: Self.home)
        }
    }
}

// MARK: - Downloads

extension WebShellController: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        // Written hidden and named once whole, like an export; see `SavedFiles`. The
        // download carries the session itself — it runs in the web view's own store.
        let partial = folder.reserve()
        downloads[ObjectIdentifier(download)] = (partial, suggestedFilename)
        completionHandler(partial)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let entry = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do {
            saved(try folder.keep(entry.partial, as: entry.name), canOpen: true)
        } catch {
            try? FileManager.default.removeItem(at: entry.partial)
            showBanner("Couldn’t save \(entry.name)")
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let entry = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        try? FileManager.default.removeItem(at: entry.partial)
        showBanner("Couldn’t download \(entry.name)")
    }
}

// MARK: - What the page asks the person

extension WebShellController: WKUIDelegate {
    /// `target=_blank` and `window.open`. No second web view is ever made; the address is
    /// sent where it belongs and the page is told there is no window.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url { route(url.absoluteString) }
        return nil
    }

    /*
     * `alert`, `confirm` and `prompt`. A WKWebView shows none of them unless its delegate
     * does, and it does not fail loudly: `confirm()` simply returns false, so a page that
     * asks "delete this?" would be told no, every time, without anyone having been asked.
     * Each completion handler has to be called exactly once, including when there is
     * nowhere to show the question.
     */
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        ask(alert, otherwise: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        ask(alert) { completionHandler(false) }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text ?? "")
        })
        ask(alert) { completionHandler(nil) }
    }

    private func ask(_ alert: UIAlertController, otherwise: () -> Void) {
        // Something is already over the page — a sheet, another question — or the page
        // is not on screen. The page gets the answer that changes nothing.
        guard viewIfLoaded?.window != nil, presentedViewController == nil else { return otherwise() }
        present(alert, animated: true)
    }
}
