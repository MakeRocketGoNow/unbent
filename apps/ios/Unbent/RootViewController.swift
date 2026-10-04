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

    /// The capture sheet, while one is up, and what it is showing. See `dismissForSignOut`.
    private weak var captureSheet: UIViewController?
    private weak var captureModel: CaptureModel?

    /// Files opened in the app before its first screen was up, held until it is.
    private var filesToCapture: [URL] = []
    private var appeared = false

    /// Where to go once there is a site to go anywhere on: a note whose notification was
    /// tapped before the view loaded, or while signed out.
    private var pendingPath: String?

    init() {
        // Made as the Share Extension makes them (`Captures`). A build whose group is
        // named but not provisioned still gets a defaults suite, private to the app,
        // and it is the Keychain that then refuses — see `signIn`.
        prefs = Captures.prefs()
        sessions = Captures.sessions()
        super.init(nibName: nil, bundle: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(captureSignedOut(_:)), name: AppCaptures.signedOut, object: nil
        )
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

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
        guard !filesToCapture.isEmpty else { return }
        let files = filesToCapture
        filesToCapture = []
        capture(files)
    }

    func becameActive() {
        shell?.becameActive()
    }

    func enteredBackground() {
        shell?.enteredBackground()
    }

    /// The instance the app is pointed at; `Captures.instance` says which that can be.
    private var instance: String { Captures.instance(prefs) }

    /// Goes to `path` on the site: now if the site is up, and otherwise when it next is.
    func open(path: String) {
        if let shell {
            shell.open(path: path)
        } else {
            pendingPath = path
        }
    }

    private func start() {
        let origin = instance
        if sessions.session(for: origin) != nil {
            let shell = WebShellController(origin: origin, sessions: sessions, startPath: pendingPath)
            pendingPath = nil
            shell.delegate = self
            self.shell = shell
            show(shell)
            // Quietly, with no prompt: see `CaptureNotifications`. Asked once someone is
            // signed in, since nothing is captured before that.
            CaptureNotifications.request()
            // What was shared while signed out has been waiting for exactly this.
            AppCaptures.queue?.resumeAll()
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

    // MARK: - Captures

    /// A file opened in the app from another one: the sheet the share extension shows,
    /// here, and the same queue behind its Save.
    ///
    /// The files are copied before anything else, as in the extension and for the same
    /// reason: the address that came with "Open in" is a grant to read another app's
    /// file, and it does not outlive this process.
    func capture(_ urls: [URL]) {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return }
        // A file that launched the app arrives while the scene is still connecting,
        // before this controller is on screen, and UIKit refuses a sheet presented from
        // a view that is not in a window: nothing showed, and the directory made below
        // was left for the sweep. Held until there is a screen to present on.
        guard appeared else {
            filesToCapture += files
            return
        }
        let jobId = CaptureJob.newId()
        let origin = instance
        let session = sessions.session(for: origin)
        let store = Captures.store()
        let model = CaptureModel()

        let sheet = UIHostingController(rootView: CaptureHost(
            model: model,
            origin: origin,
            session: session,
            lastNotebook: prefs.lastNotebook,
            onSave: { [weak self] title, notebook, tags in
                guard let self, let intake = model.intake else { return }
                if session != nil, !model.signedOut { self.prefs.lastNotebook = notebook }
                AppCaptures.queue?.submit(CaptureJob(
                    id: jobId, origin: origin, intake: intake, title: title, notebook: notebook, tags: tags
                ))
                self.dismiss(animated: true)
            },
            onCancel: { [weak self] in
                store?.clear(jobId)
                self?.dismiss(animated: true)
            }
        ))
        // Cancel or Save, not a swipe: a swipe would leave the copied files behind with
        // nothing to say whether they were wanted.
        sheet.isModalInPresentation = true
        // Over whatever is up — App settings, a Safari sheet — rather than not at all.
        var presenter: UIViewController = self
        while let presented = presenter.presentedViewController { presenter = presented }
        presenter.present(sheet, animated: true)
        captureSheet = sheet
        captureModel = model

        guard let store, let directory = try? store.create(jobId) else {
            model.problem = CaptureModel.noRoom
            return
        }
        Task.detached(priority: .userInitiated) {
            let stager = CaptureStager(directory: directory)
            var intake = CaptureIntake()
            intake.files = files.compactMap { stager.stage(securityScoped: $0) }
            let staged = intake
            await MainActor.run { model.staged(staged) }
        }
    }

    /// A capture's upload was refused for this instance's session, and the queue has
    /// forgotten it. The same ending as the page saying so.
    @objc private func captureSignedOut(_ note: Notification) {
        guard let origin = note.object as? String, normalizeOrigin(origin) == instance, shell != nil else { return }
        dismissForSignOut()
        clearCookies { [weak self] in self?.start() }
    }

    /// Takes down whatever is over the site as the site goes — Safari, App settings, a
    /// preview — unless a capture sheet is among it.
    ///
    /// That sheet is someone partway through filing a file, and it works signed out: its
    /// Save queues the capture for the next sign-in. Dismissing it from here skipped its
    /// Cancel, so the form vanished mid-word and the copied file was left behind for
    /// the sweep. So it stays, over the sign-in screen, until Save or Cancel, and is told
    /// it is signed out now, so it says what Save will do.
    private func dismissForSignOut() {
        if captureSheet?.presentingViewController != nil {
            captureModel?.signedOut = true
            return
        }
        dismiss(animated: false)
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
        dismissForSignOut()
        clearCookies { [weak self] in self?.start() }
    }

    func shellWantsSettings(_ shell: WebShellController) {
        openSettings()
    }
}
