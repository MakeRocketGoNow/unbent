import os
import SwiftUI
import UIKit
import UnbentCore
import UnbentUI
import WebKit

/// The app: either the site, or the screen that signs in to it.
///
/// The site, whole, in one web view (`WebShellController`), with native code only for what
/// a page cannot do on an iPhone — sign-in, saving files, links that leave, and the app's
/// own address and version. It is the Android app's shape (`MainActivity.kt`), for the
/// reason given there: every feature the site gains would otherwise be built a second time.
///
/// This controller holds the two things that outlive either screen — which instance, and
/// the session for it — and swaps between them. Nothing is shown before sign-in: nothing
/// in the app works without a session, so there is nothing to show first.
final class RootViewController: UIViewController {
    private let prefs: AppPrefs
    private let sessions: SessionStoring

    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "unbent", category: "app")

    private var shell: WebShellController?
    private var current: UIViewController?

    init() {
        // The App Group's defaults, so the Share Extension reads the same instance. The
        // fallback is only for a build with no group named at all: one whose group is
        // named but not provisioned still gets a suite here, private to the app, and it
        // is the Keychain that then refuses — see `signIn`.
        let defaults = BuildInfo.appGroup.flatMap(UserDefaults.init(suiteName:)) ?? .standard
        prefs = AppPrefs(defaults: defaults, defaultInstance: BuildInfo.defaultInstance)
        sessions = SessionStore(accessGroup: BuildInfo.appGroup)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not in a storyboard") }

    // The page's colour decides the status bar's, and only the screen showing knows it.
    override var childForStatusBarStyle: UIViewController? { current }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .unbentGround
        // A file half-saved when the app was last killed is not a file.
        SavedFiles.downloads().sweep()
        start()
    }

    func becameActive() {
        shell?.becameActive()
    }

    func enteredBackground() {
        shell?.enteredBackground()
    }

    /// The instance the app is pointed at. Only a debug build's can be anything but the
    /// one it was built for: the web view opens its App-Bound Domains and nothing else,
    /// and a release build has exactly one.
    private var instance: String {
        BuildInfo.isDebug ? prefs.instance : normalizeOrigin(BuildInfo.defaultInstance)
    }

    private func start(path: String? = nil) {
        let origin = instance
        if sessions.session(for: origin) != nil {
            let shell = WebShellController(origin: origin, sessions: sessions, startPath: path)
            shell.delegate = self
            self.shell = shell
            show(shell)
        } else {
            shell = nil
            show(signIn(origin: origin))
        }
    }

    private func signIn(origin: String) -> UIViewController {
        // The system's sheets stand on this controller's window, whichever screen is up.
        let sheets = SignInSheets { [weak self] in self?.view.window }
        let model = SignInModel(origin: origin, connectScheme: BuildInfo.connectScheme, sheets: sheets) { [weak self] session in
            guard let self else { return false }
            // Every way in ends here: the cookie the response set, kept for this instance.
            // If it cannot be kept the sign-in screen stays and says so; starting over
            // would find no session and show the same screen again, emptied, as though
            // nothing had been typed.
            do {
                try self.sessions.save(session, for: origin)
            } catch {
                self.log.error("Could not keep the session: \(String(describing: error), privacy: .public)")
                return false
            }
            // The shell takes a session cookie it finds in the web view for newer than
            // the Keychain's. Straight after a sign-in the opposite is true, so anything
            // left there from before goes first.
            self.clearCookies { [weak self] in self?.start() }
            return true
        }
        let screen = SignInHost(
            model: model,
            onChangeInstance: BuildInfo.isDebug ? { [weak self] in self?.openSettings() } : nil
        )
        return UIHostingController(rootView: screen)
    }

    private func show(_ next: UIViewController) {
        let previous = current
        current = next
        addChild(next)
        next.view.frame = view.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(next.view)
        next.didMove(toParent: self)
        setNeedsStatusBarAppearanceUpdate()

        guard let previous else { return }
        previous.willMove(toParent: nil)
        // A short fade: the two screens share nothing, and a cut between them reads as
        // the app restarting.
        next.view.alpha = 0
        UIView.animate(withDuration: 0.2) {
            next.view.alpha = 1
        } completion: { _ in
            previous.view.removeFromSuperview()
            previous.removeFromParent()
        }
    }

    // MARK: - App settings

    private func openSettings() {
        guard presentedViewController == nil else { return }
        let screen = AppSettingsScreen(
            instance: instance,
            allowedHosts: BuildInfo.appBoundHosts,
            version: BuildInfo.version,
            build: BuildInfo.build,
            onUse: BuildInfo.isDebug ? { [weak self] in self?.use($0) } : nil,
            onReset: BuildInfo.isDebug ? { [weak self] in self?.resetWebData() } : nil,
            onDone: { [weak self] in self?.dismiss(animated: true) }
        )
        present(UIHostingController(rootView: screen), animated: true)
    }

    /// Points the app at another instance and starts it over there.
    ///
    /// The session for the old address stays in the Keychain under that address, so
    /// pointing back finds it again and nobody signs in twice to move between a laptop's
    /// dev server and the real one. The web view's cookies go, because it would otherwise
    /// hold the old site's beside the new; the right session is written into it again
    /// before the next load.
    private func use(_ address: String) {
        dismiss(animated: true)
        clearCookies { [weak self] in
            self?.prefs.instance = address
            self?.start()
        }
    }

    private func resetWebData() {
        dismiss(animated: true)
        WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) { [weak self] in
            self?.start()
        }
    }

    private func clearCookies(then done: @escaping () -> Void) {
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeCookies],
            modifiedSince: .distantPast,
            completionHandler: done
        )
    }
}

extension RootViewController: WebShellDelegate {
    /// Back to sign-in, whether the person chose to leave or the server stopped knowing
    /// them. The web view's cookies are cleared too: a stale one there would let the page
    /// keep working for a while on a session the app itself has forgotten.
    func shellDidSignOut(_ shell: WebShellController) {
        guard shell === self.shell else { return }
        sessions.clear(for: instance)
        dismiss(animated: false)
        clearCookies { [weak self] in self?.start() }
    }

    func shellWantsSettings(_ shell: WebShellController) {
        openSettings()
    }
}
