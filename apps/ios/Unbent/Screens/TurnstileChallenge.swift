import Observation
import SwiftUI
import UnbentCore
import UnbentUI
import WebKit

/// Mints a Turnstile token for the request for a sign-in code, from the instance's own
/// page in a web view (MAK-243).
///
/// Where the instance checks a token with that request (`AppConfig.turnstile`), the
/// sign-in screen, which makes the request itself, needs one, and Turnstile runs in a
/// browser and nowhere else. So `/turnstile` is loaded in a `WKWebView` the screen holds
/// at no height, and the page says what the widget concluded through the bridge:
/// `turnstile` with the token, or `turnstile-error`. The page reads the site key from
/// `/api/config` itself, so the app and the page cannot disagree about whose key it is.
///
/// Managed Turnstile passes nearly every phone without a tap. When it does want one, the
/// page says `turnstile-interactive` first and `interactive` goes true, which is what
/// `ChallengeHost` gives the view its height on: the widget appears under the form for as
/// long as the tap takes. The view is in the screen's tree the whole time rather than
/// held off it, since WebKit may not run a page in a view that is in no window.
///
/// Bound to the app's domains like the shell's web view (`WebShellController`), which is
/// why the instance's host has to be in `WKAppBoundDomains` for this to load at all;
/// Turnstile's own frame is a subframe on Cloudflare's host, which the list does not
/// restrict. A token is spent by one request, so one of these is made for every request.
///
/// The Android app's half is `TurnstileChallenge.kt`.
@MainActor
@Observable
final class TurnstileChallenge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    /// Long enough for a slow radio and a widget waiting on a tap; well short of forever.
    static let timeout: Duration = .seconds(60)

    let webView: WKWebView
    private(set) var interactive = false

    private let origin: String
    private var waiting: CheckedContinuation<String?, Error>?
    private var deadline: Task<Void, Never>?

    struct Failed: Error, LocalizedError {
        let reason: String
        var errorDescription: String? { reason }
    }

    init(origin: String, bound: Bool) {
        self.origin = origin
        let config = WKWebViewConfiguration()
        // The app's own store, so the page's shell comes from the cache the site's own
        // web view keeps rather than cold off the radio on every press: the page is the
        // whole site, and in a store of its own each press downloaded the build again.
        // Nothing of this page is worth keeping or hiding, and it registers no worker.
        config.websiteDataStore = .default()
        config.limitsNavigationsToAppBoundDomains = bound
        config.applicationNameForUserAgent = "UnbentiOS/\(BuildInfo.version)"
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        super.init()
        // The same object the shell installs, so the page posts to the app the one way it
        // knows; only the plain message handler is listened to, since this page saves nothing.
        config.userContentController.addUserScript(Bridge.script)
        config.userContentController.add(self, name: Bridge.messages)
        webView.navigationDelegate = self
    }

    /// Loads the page and waits for its one word: the token, or nil when the instance asks
    /// for none after all (`turnstile-none`: the check was turned off since the config was
    /// read, and the request goes without one). Throws `Failed` when the page could not
    /// mint a token, the load failed, or `timeout` passed.
    func token() async throws -> String? {
        guard let url = URL(string: origin + "/turnstile") else { throw Failed(reason: "bad origin") }
        return try await withCheckedThrowingContinuation { continuation in
            waiting = continuation
            deadline = Task { [weak self] in
                try? await Task.sleep(for: Self.timeout)
                guard !Task.isCancelled else { return }
                self?.finish(.failure(Failed(reason: "timed out")))
            }
            webView.load(URLRequest(url: url))
        }
    }

    private func finish(_ result: Result<String?, Error>) {
        deadline?.cancel()
        deadline = nil
        guard let waiting else { return }
        self.waiting = nil
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Bridge.messages)
        waiting.resume(with: result)
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let text = message.body as? String else { return }
        guard let message = BridgeMessage.parse(text) else { return }
        if message.isTurnstile {
            if let token = message.token, !token.isEmpty {
                finish(.success(token))
            } else {
                finish(.failure(Failed(reason: "empty token")))
            }
        } else if message.isTurnstileNone {
            finish(.success(nil))
        } else if message.isTurnstileError {
            finish(.failure(Failed(reason: message.message ?? "turnstile-error")))
        } else if message.isTurnstileInteractive {
            interactive = true
        }
    }

    // MARK: WKNavigationDelegate

    /// The page itself failing to load. Turnstile's own script failing is the page's to
    /// report, as `turnstile-error`.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(Failed(reason: error.localizedDescription)))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(Failed(reason: error.localizedDescription)))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.failure(Failed(reason: "content process gone")))
    }
}

/// The challenge's web view in the sign-in screen: no height until the widget wants a
/// tap, then the Managed widget's own, under the form it is checking for.
struct ChallengeHost: View {
    let challenge: TurnstileChallenge

    var body: some View {
        WebViewBox(webView: challenge.webView)
            // The widget's 65pt plus a little for its border; nothing while it is quiet.
            .frame(maxWidth: .infinity)
            .frame(height: challenge.interactive ? 72 : 0)
            .clipped()
            .padding(.top, challenge.interactive ? Space.large : 0)
    }
}

private struct WebViewBox: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
