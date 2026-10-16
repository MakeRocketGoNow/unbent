import SwiftUI
import UIKit
import UnbentCore
import UnbentUI

/// The share-sheet entry point: a sheet over the sending app, then an upload nobody waits
/// for.
///
/// What was shared is copied into the App Group's container the moment this starts,
/// because what a share hands over lasts only as long as the sheet. Everything after that
/// (naming, filing, the upload) depends on nothing but that copy.
///
/// Save hands one request to the system and closes. This process is killed moments later,
/// so nothing is uploaded from it: the system sends the request, and the app, launched in
/// the background with the answer, sends the files (`CaptureQueue`). The notification
/// says when the note has landed.
///
/// The Android app's half is `ShareActivity.kt`.
final class ShareViewController: UIViewController {
    private let jobId = CaptureJob.newId()
    private let prefs = Captures.prefs()
    private let sessions = Captures.sessions()
    private let store = Captures.store()
    private let model = CaptureModel()

    /// Held for as long as this process lasts: it is the delegate of the session the
    /// request went into.
    private var queue: CaptureQueue?
    private var submitted = false

    private lazy var origin = Captures.instance(prefs)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .unbentGround
        let session = sessions.session(for: origin)
        let sheet = UIHostingController(rootView: CaptureHost(
            model: model,
            origin: origin,
            session: session,
            lastNotebook: prefs.lastNotebook,
            onSave: { [weak self] in self?.save(title: $0, notebook: $1, tags: $2, signedIn: session != nil) },
            onCancel: { [weak self] in self?.cancel() }
        ))
        addChild(sheet)
        sheet.view.frame = view.bounds
        sheet.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(sheet.view)
        sheet.didMove(toParent: self)
        stage()
    }

    /// The sheet was swiped away, which is a cancel nobody tapped.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !submitted { store?.clear(jobId) }
    }

    private func stage() {
        guard let store, let directory = try? store.create(jobId) else {
            model.problem = CaptureModel.noRoom
            return
        }
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let contentText = items.first?.attributedContentText?.string
        Task {
            let intake = await CaptureStager(directory: directory).stage(providers, contentText: contentText)
            model.staged(intake)
        }
    }

    private func save(title: String, notebook: String?, tags: [String], signedIn: Bool) {
        guard !submitted, let store, let intake = model.intake else { return }
        submitted = true
        // Signed out there was no list to choose from, and "Inbox" then is not a choice
        // to remember over the last real one.
        if signedIn { prefs.lastNotebook = notebook }

        let queue = CaptureQueue(
            store: store,
            home: CaptureQueue.shareSession(appId: BuildInfo.appId, jobId: jobId),
            role: .shareExtension,
            appGroup: BuildInfo.appGroup,
            sessions: sessions,
            notifier: CaptureNotifications()
        )
        self.queue = queue
        let job = CaptureJob(id: jobId, origin: origin, intake: intake, title: title, notebook: notebook, tags: tags)
        queue.submit(job) { [weak self] in
            // Only now: closing before the system has the request loses it.
            DispatchQueue.main.async { self?.extensionContext?.completeRequest(returningItems: nil) }
        }
    }

    /// Dismissed without saving: the copied files are not wanted, so they go.
    private func cancel() {
        submitted = true
        store?.clear(jobId)
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }
}
