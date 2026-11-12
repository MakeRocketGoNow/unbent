import Foundation
import os

/// What a capture tells the person, as it goes. One notification per capture, replaced in
/// place; `CaptureNotifications` is the real one.
public protocol CaptureNotifying: Sendable {
    func saving(_ job: CaptureJob)
    func waiting(_ job: CaptureJob)
    func saved(_ job: CaptureJob)
    func failed(_ job: CaptureJob)
    func signInNeeded(_ job: CaptureJob)
    func refused(_ job: CaptureJob, _ refusal: CaptureRefusal, again: Bool)
}

/// Uploads captures in the system's background sessions, and applies what comes back.
///
/// Nothing here uploads in-process, because no process of this app's lives long enough
/// to: the share extension is killed when its sheet closes, and the app is suspended
/// seconds after it leaves the screen. A background `URLSession` hands each request to
/// the system, which sends it whether or not anything of ours is running and launches
/// the app, in the background, to hear the result.
///
/// The requests go one stage at a time, because a background session promises no order:
/// the note first, and its files only once the note is known to exist. So the extension
/// sends one request and goes, and it is the app, woken with the answer, that sends the
/// files. Each result is applied to the capture's record by `CaptureJob.handle`, which is
/// where the rules are and where they are tested; this class is the plumbing either side.
///
/// **Two kinds of session, deliberately.** Only one process may use a background session
/// at a time, and Apple's guidance is a session per process. The app's is `home` and
/// lives as long as the app. The extension's is one per capture, named for it: a second
/// share while the first is still uploading then never meets the first's session, and
/// the app joins a capture's session by the name in its record (`shareSession`) to
/// collect what the extension started. A single shared name was the plan; it has the
/// extension and the woken app contending for it whenever two shares come close together.
///
/// **A retry is the system's to time.** A request to be sent later is created now with
/// `earliestBeginDate`, and the system holds it: through a suspended app, a relaunch, a
/// restart of the phone. A background refresh task was the other way, and would have been
/// a timer the system may never fire for an app nobody has opened lately.
///
/// **What makes sending twice safe** is in `CaptureJob`: both requests carry ids of the
/// capture's choosing. This class relies on it wherever it cannot know whether a request
/// is still out: a result that arrives while the list of live requests is being read.
public final class CaptureQueue: NSObject, @unchecked Sendable {
    public enum Role: Equatable, Sendable {
        /// The app: one long-lived session, and every capture on disk is its to finish.
        case app
        /// The share extension, for the one capture its sheet is making.
        case shareExtension
    }

    private let store: CaptureStore
    private let home: String
    private let role: Role
    private let appGroup: String?
    private let sessions: SessionStoring
    private let notifier: CaptureNotifying
    private let onSignedOut: @Sendable (String) -> Void
    private let whoAmI: @Sendable (_ origin: String, _ bearer: String) async -> String?
    /// The account each instance's session belongs to, as last answered, with the
    /// session it was answered for: asked once per session, not once per pass. Read and
    /// written on `work`.
    private var accounts: [String: (bearer: String, id: String)] = [:]

    /// Everything below runs here: the sessions' delegate calls, and every read and write
    /// of a capture's record. One queue is what makes "load, change, save" a step nothing
    /// else can land in the middle of, in this process. The extension is another one,
    /// and what protects against it is that it sends a single request and exits.
    private let work = DispatchQueue(label: "app.unbent.capture")
    private var urlSessions: [String: URLSession] = [:]
    private var eventHandlers: [String: () -> Void] = [:]
    /// Sessions whose results were all applied before the system's handler for them had
    /// arrived. See `handleEvents`.
    private var finishedEarly = Set<String>()
    /// Whether a pass of `resumeAll` is under way, and whether another was asked for
    /// meanwhile. Read and written on `work`.
    private var resuming = false
    private var resumeAgain = false
    /// Whether the pass waiting behind this one was asked to send refused captures too,
    /// and what it was told there is room of.
    private var resumeAgainRefused = false
    private var resumeAgainRoom: CaptureRefusal?
    /// What the server has said so far with each 402 still arriving, by the request's
    /// label. Read and written on `work`. See `urlSession(_:dataTask:didReceive:)`.
    private var refusals: [CaptureStep.Key: Data] = [:]
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "unbent", category: "capture")

    /// The app's session, named for the app.
    public static func appSession(appId: String) -> String { "\(appId).capture" }

    /// The extension's session for one capture. Prefixed with the app's, so the app can
    /// tell a wake-up for one of these from anything else.
    public static func shareSession(appId: String, jobId: String) -> String { "\(appId).capture.share.\(jobId)" }

    /// - Parameters:
    ///   - home: the session new requests go into: `appSession` or `shareSession`.
    ///   - appGroup: where the system keeps what it is uploading for the extension.
    ///   - onSignedOut: an instance's session was refused and has been forgotten.
    ///   - whoAmI: the id of the account a session belongs to, asked of its instance
    ///     (`/api/me`), or nil when it could not be asked. What a kept capture is held
    ///     to; see `CaptureJob.mayGo`.
    public init(
        store: CaptureStore,
        home: String,
        role: Role,
        appGroup: String?,
        sessions: SessionStoring,
        notifier: CaptureNotifying,
        onSignedOut: @escaping @Sendable (String) -> Void = { _ in },
        whoAmI: @escaping @Sendable (_ origin: String, _ bearer: String) async -> String? = { origin, bearer in
            (try? await UnbentApi(origin: origin, bearer: bearer).me())?.id
        }
    ) {
        self.store = store
        self.home = home
        self.role = role
        self.appGroup = appGroup
        self.sessions = sessions
        self.notifier = notifier
        self.onSignedOut = onSignedOut
        self.whoAmI = whoAmI
    }

    // MARK: - In

    /// Takes a capture at Save: writes its record, and sends the note if there is a
    /// session to send it with. Signed out, the record is all there is, and the app
    /// sends it after the next sign-in (`resumeAll`): the files are already staged.
    ///
    /// `done` is called once the system has the request, which is when an extension may
    /// close: a request it has only been asked to take is lost with the process.
    public func submit(_ job: CaptureJob, done: @escaping @Sendable () -> Void = {}) {
        work.async {
            var job = job
            if self.role == .shareExtension { job.shareSession = self.home }
            do {
                _ = try self.store.create(job.id)
                try job.save(to: self.store.directory(job.id))
            } catch {
                self.log.error("Could not write the capture's record: \(String(describing: error), privacy: .public)")
                self.notifier.failed(job)
                return done()
            }
            // Only when there is a session to send it with: signed out, nothing is being
            // saved yet, and the sheet has said what happens instead.
            if self.sessions.session(for: job.origin) != nil { self.notifier.saving(job) }
            self.send(.create, of: job)
            // A round trip to the system's uploader, behind the request just handed over.
            self.session(self.home).getAllTasks { _ in done() }
        }
    }

    /// Sends whatever the captures on disk still need and nothing is carrying: after a
    /// launch, when the app comes forward, and after a sign-in.
    ///
    /// The system wakes the app for a result, but not an app the person force-quit, and
    /// not for a capture that was never sent because nobody was signed in. This is the
    /// other way a capture moves, and it is safe to call at any time.
    ///
    /// One pass at a time. A cold launch asks three times within a moment (at launch,
    /// when the site starts, when the scene becomes active) and a pass reads what the
    /// system holds before it sends. Three at once each read the list before any had
    /// sent, and each sent everything: correct, because of the ids, and a 100 MB video
    /// uploaded three times over a phone connection. A call during a pass asks for one
    /// more after it, however many calls there were, since something may have changed.
    ///
    /// `refused` also sends the captures the plan refused (`CaptureRefusal`), and is true
    /// only when the app has come in front of the person: that is the moment after they
    /// could have subscribed or made room, in Safari or on another device. Not on every
    /// launch, because the system launches the app to hear a request's answer, and a
    /// launch that sent a refused capture again would be launched again for its refusal,
    /// for as long as the plan stayed as it was.
    ///
    /// `roomFor` is the reason a capture that has just landed had been refused for:
    /// there is room of that kind now, so the others kept for it go without waiting out
    /// a quiet spell that can be six hours. Otherwise the scans behind the first one to
    /// land arrived hours apart.
    public func resumeAll(refused: Bool = false, roomFor: CaptureRefusal? = nil) {
        work.async {
            guard !self.resuming else {
                self.resumeAgain = true
                self.resumeAgainRefused = self.resumeAgainRefused || refused
                self.resumeAgainRoom = roomFor ?? self.resumeAgainRoom
                return
            }
            self.resuming = true
            let jobs = self.jobsOnDisk()
            guard !jobs.isEmpty else { return self.finishedResuming() }
            let identifiers = Set([self.home] + jobs.compactMap(\.shareSession))
            self.liveRequests(in: identifiers) { live, idle in
                // Whose session each instance's is, for the captures that are held to an
                // account. Asked before the choosing, so one that may not go is never
                // chosen; on every pass, since one whose refusal a 401 cleared goes on
                // an ordinary pass; and once per session, so most passes ask nothing.
                let held = Set(self.jobsOnDisk().filter { $0.account != nil }.map(\.origin))
                self.accounts(for: Array(held)) { current in
                    // Read again: results may have been applied while the lists were fetched.
                    let jobs = self.jobsOnDisk()
                    // One refused capture for each reason, not all of them; see there.
                    // Among those that can go: one kept for an instance nobody is signed
                    // in to, or for another account than the one signed in, cannot, and
                    // chosen it would stand in front of every capture kept for the same
                    // reason that can.
                    let sendable = jobs.filter {
                        self.sessions.session(for: $0.origin) != nil && $0.mayGo(as: current[$0.origin])
                    }
                    let asked = refused ? CaptureJob.firstOfEachRefusal(sendable) : []
                    for job in jobs {
                        if job.isSaved { self.apply(.saved, to: job); continue }
                        guard job.mayGo(as: current[job.origin]) else { continue }
                        if job.refused != nil, !asked.contains(job.id) { continue }
                        // Nothing for most; for a refused file or clip, the rest of its
                        // quiet spell, which the system then holds the request for.
                        let wait = job.refused == roomFor ? 0 : job.refusedWait()
                        for step in job.pending(live: live) {
                            // A note going out for the first time from here is one that
                            // waited for a sign-in, and now there is something to say. Not
                            // one the plan refused: "Saving…" would replace the notice that
                            // says why it is waiting, to be replaced by it again a moment
                            // later, every time the app is opened.
                            if step == .create, job.refused == nil, self.sessions.session(for: job.origin) != nil { self.notifier.saving(job) }
                            self.send(step, of: job, after: wait)
                        }
                    }
                    for identifier in idle where identifier != self.home { self.retire(identifier) }
                    self.finishedResuming()
                }
            }
        }
    }

    /// The account signed in on `origin`, on `work`: from what was last answered for the
    /// session held now, or asked. Nil with no session, or when the asking failed, which
    /// is not remembered, so the next pass asks again.
    private func account(for origin: String, then: @escaping @Sendable (String?) -> Void) {
        guard let bearer = sessions.session(for: origin)?.bearer else { return then(nil) }
        if let known = accounts[origin], known.bearer == bearer { return then(known.id) }
        Task {
            let id = await self.whoAmI(origin, bearer)
            self.work.async {
                if let id { self.accounts[origin] = (bearer, id) }
                then(id)
            }
        }
    }

    /// `account(for:)` for several instances, one after another, then all of them.
    private func accounts(for origins: [String], found: [String: String] = [:], then: @escaping @Sendable ([String: String]) -> Void) {
        guard let origin = origins.first else { return then(found) }
        account(for: origin) { id in
            var found = found
            found[origin] = id
            self.accounts(for: Array(origins.dropFirst()), found: found, then: then)
        }
    }

    private func finishedResuming() {
        resuming = false
        guard resumeAgain else { return }
        let refused = resumeAgainRefused
        let room = resumeAgainRoom
        resumeAgain = false
        resumeAgainRefused = false
        resumeAgainRoom = nil
        resumeAll(refused: refused, roomFor: room)
    }

    /// The app was launched, or resumed in the background, because requests in
    /// `identifier` finished. Joining the session is what delivers their results;
    /// `completion` is the system's, called once they have all been applied.
    ///
    /// False for a session that is not one of this queue's.
    public func handleEvents(identifier: String, completion: @escaping () -> Void) -> Bool {
        guard identifier == home || identifier.hasPrefix(home + ".share.") else { return false }
        work.async {
            // The handler can arrive after the results it is for. Launch looks at the
            // queue (`resumeAll`), which joins the sessions, and UIKit calls this later
            // in the same launch; a session that has delivered everything by then will
            // not finish again, and a handler stored for it would never be called. The
            // system counts that as background work never finished, and is slower to
            // launch the app for the next upload.
            if self.finishedEarly.remove(identifier) != nil {
                DispatchQueue.main.async(execute: completion)
                return
            }
            self.eventHandlers[identifier] = completion
            _ = self.session(identifier)
        }
        return true
    }

    /// Removes captures nobody finished or cancelled, and says so for the ones someone
    /// had saved. See `CaptureStore.sweepAbandoned`.
    public func sweep() {
        work.async {
            for job in self.store.sweepAbandoned() { self.notifier.failed(job) }
        }
    }

    // MARK: - Sending

    private func session(_ identifier: String) -> URLSession {
        if let session = urlSessions[identifier] { return session }
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sharedContainerIdentifier = appGroup
        // Now, on whatever network there is: someone is waiting for "Saved".
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        // From the request's creation, so it covers the longest wait a server may ask
        // for (`CaptureJob.longestWait`) and a slow upload after it.
        config.timeoutIntervalForResource = 24 * 60 * 60
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = work
        delegateQueue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
        urlSessions[identifier] = session
        return session
    }

    /// Hands one request to the system. A capture with no session to send it with stays
    /// as it is, on disk, for `resumeAll` after a sign-in.
    ///
    /// It posts no notification, and has to stay that way: this is also how a request is
    /// sent again after the server asked for time, and "Saving…" posted from here
    /// replaced "Waiting for Unbent to come back" the moment it went up.
    private func send(_ step: CaptureStep, of job: CaptureJob, after delay: TimeInterval = 0) {
        guard let bearer = sessions.session(for: job.origin)?.bearer else { return }
        let directory = store.directory(job.id)
        do {
            let request: URLRequest
            let body: URL
            switch step {
            case .create:
                // A background session uploads from a file and nothing else, so the
                // JSON is one.
                let made = try CaptureRequests.create(job, bearer: bearer)
                body = directory.appendingPathComponent(CaptureJob.createBodyName)
                try made.body.write(to: body, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                request = made.request
            case .file(let id):
                guard let file = job.file(id) else { return }
                body = directory.appendingPathComponent(file.name)
                guard FileManager.default.fileExists(atPath: body.path) else {
                    return update(job.id) { $0.skip(id) }
                }
                request = try CaptureRequests.upload(file, of: job, bearer: bearer)
            }
            let task = session(home).uploadTask(with: request, fromFile: body)
            task.taskDescription = step.key(job: job.id)
            if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
            task.resume()
        } catch {
            log.error("Could not send \(step.key(job: job.id), privacy: .public): \(String(describing: error), privacy: .public)")
            apply(.failed, to: job)
        }
    }

    // MARK: - Results

    /// Loads a capture's record, changes it, writes it back, and does what follows. A
    /// capture that is no longer on disk (saved, given up on) has nothing to change.
    private func update(_ jobId: String, _ change: (inout CaptureJob) -> CaptureAction) {
        let directory = store.directory(jobId)
        guard var job = CaptureJob.load(from: directory) else { return }
        let action = change(&job)
        do {
            try job.save(to: directory)
        } catch {
            // Carried on with: the worst a stale record does is send a request again.
            log.error("Could not write the capture's record: \(String(describing: error), privacy: .public)")
        }
        apply(action, to: job)
    }

    private func apply(_ action: CaptureAction, to job: CaptureJob) {
        switch action {
        case .wait:
            break
        case .send(let steps):
            for step in steps { send(step, of: job) }
        case .retry(let step, let delay, let unavailable):
            // The spinner of "Saving…", left up for hours, looks stuck.
            if unavailable { notifier.waiting(job) }
            send(step, of: job, after: delay)
        case .saved:
            store.clear(job.id)
            notifier.saved(job)
            // Something landed, so there may be room: the captures the plan refused
            // were waiting on an answer like this one (`CaptureJob.firstOfEachRefusal`).
            // Only after a success, so a wake-up for a refusal never sends another, and
            // after any capture, as on Android: a share made today that lands is as good
            // a sign as a kept one. Those kept for the reason this one had been refused
            // for go at once.
            if jobsOnDisk().contains(where: { $0.refused != nil }) {
                resumeAll(refused: true, roomFor: job.landedAfter)
            }
        case .signInNeeded:
            // The stale session would fail every later share the same way, silently.
            sessions.clear(for: job.origin)
            // The files stay. With no session `send` does nothing, so the capture is now
            // exactly one made while signed out, and `resumeAll` after the next sign-in
            // sends what is left of it. Its other requests carry the same dead session
            // and are recalled rather than left to be refused one by one.
            cancelRequests(of: job)
            notifier.signInNeeded(job)
            onSignedOut(job.origin)
        case .refused(let refusal, let again):
            // The files stay, and so does the record, which now says why
            // (`CaptureJob.refused`). Its other requests would be refused one by one for
            // the same reason, each a file uploaded to hear it, so they are recalled;
            // `resumeAll(refused: true)` sends what is left when the app is next opened.
            cancelRequests(of: job)
            notifier.refused(job, refusal, again: again)
        case .failed:
            end(job)
            notifier.failed(job)
        }
    }

    /// Stops a capture that will not be finished: its files go, and so do the requests
    /// still out for it, which would otherwise fail one by one against a missing file.
    private func end(_ job: CaptureJob) {
        store.clear(job.id)
        cancelRequests(of: job)
    }

    private func cancelRequests(of job: CaptureJob) {
        for session in urlSessions.values {
            session.getAllTasks { tasks in
                for task in tasks where CaptureStep.parse(task.taskDescription)?.job == job.id { task.cancel() }
            }
        }
    }

    private func jobsOnDisk() -> [CaptureJob] {
        store.jobIds().compactMap { CaptureJob.load(from: store.directory($0)) }
    }

    /// The labels of every request the system still holds in these sessions, and which
    /// of the sessions hold none.
    private func liveRequests(in identifiers: Set<String>, then: @escaping (Set<CaptureStep.Key>, [String]) -> Void) {
        var live = Set<CaptureStep.Key>()
        var idle: [String] = []
        let group = DispatchGroup()
        for identifier in identifiers {
            group.enter()
            session(identifier).getAllTasks { tasks in
                // On the delegate queue, which is `work`.
                let running = tasks.filter { $0.state == .running || $0.state == .suspended }
                live.formUnion(running.compactMap(\.taskDescription))
                if running.isEmpty { idle.append(identifier) }
                group.leave()
            }
        }
        group.notify(queue: work) { then(live, idle) }
    }

    /// Lets go of a capture's own session once nothing is left in it. The system keeps a
    /// session's bookkeeping for as long as anything holds it.
    private func retire(_ identifier: String) {
        urlSessions.removeValue(forKey: identifier)?.finishTasksAndInvalidate()
    }
}

extension CaptureQueue: URLSessionTaskDelegate {
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let (jobId, step) = CaptureStep.parse(task.taskDescription) else { return }
        // Taken before anything returns: a request recalled while its 402 was arriving
        // would otherwise leave half a body under its label, for the same step's next
        // answer to be appended to and no longer read.
        let said = task.taskDescription.flatMap { refusals.removeValue(forKey: $0) }
        // One this queue cancelled itself: its capture ended, or is waiting for a sign-in.
        if (error as? URLError)?.code == .cancelled { return }

        let response = task.response as? HTTPURLResponse
        if let error {
            log.warning("\(task.taskDescription ?? "", privacy: .public) got no answer: \(error.localizedDescription, privacy: .public)")
        }
        update(jobId) { job in
            // The header the request went out with, against the session held now.
            let sent = task.originalRequest?.value(forHTTPHeaderField: "Authorization")
            let held = self.sessions.session(for: job.origin).map { "Bearer \($0.bearer)" }
            // A capture the plan refuses is kept for the account that sent it
            // (`CaptureJob.mayGo`), so whose that is gets written down: only while the
            // session that sent the request is still the one held, since it is that
            // session the instance is asked about. Asked once; a failure to ask leaves
            // the capture going as every capture did.
            if error == nil, response?.statusCode == 402, job.account == nil, held != nil, sent == held {
                self.account(for: job.origin) { id in
                    guard let id else { return }
                    self.update(jobId) { kept in
                        if kept.account == nil { kept.account = id }
                        return .wait
                    }
                }
            }
            return job.handle(step, CaptureOutcome(
                // An answer that came with an error did not finish arriving.
                status: error == nil ? response?.statusCode : nil,
                retryAfter: response?.value(forHTTPHeaderField: "Retry-After"),
                currentSession: held == nil || sent == held,
                body: said
            ))
        }
    }
}

extension CaptureQueue: URLSessionDataDelegate {
    /// The words of a 402, kept until the request completes: the one answer whose body
    /// decides anything, since its `code` says whether the plan has ended or which of its
    /// rooms is full (`CaptureRefusal`). An upload task is a data task, and its answer's
    /// body comes here ahead of `didCompleteWithError`, on the same queue.
    ///
    /// Nothing else is kept: a 2xx to a create is the whole note, and nothing reads it.
    /// Bounded, because the body is the server's and a refusal is a few hundred bytes. A
    /// 402 that arrives with no body at all still reads as the plan's (`.plan`), so the
    /// capture is kept either way and only the notice's first line is less exact.
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard (dataTask.response as? HTTPURLResponse)?.statusCode == 402, let key = dataTask.taskDescription else { return }
        var said = refusals[key] ?? Data()
        said.append(data.prefix(max(0, Self.refusalLimit - said.count)))
        refusals[key] = said
    }

    private static let refusalLimit = 16 * 1024
}

extension CaptureQueue: URLSessionDelegate {
    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        // On `work`, after the last result of this wake-up has been applied.
        guard let identifier = session.configuration.identifier else { return }
        if let handler = eventHandlers.removeValue(forKey: identifier) {
            // The system's handler is UIKit's, and is called where UIKit expects it.
            DispatchQueue.main.async(execute: handler)
        } else {
            // Nobody to tell yet; `handleEvents` is told when it asks.
            finishedEarly.insert(identifier)
        }
        guard identifier != home else { return }
        session.getAllTasks { tasks in
            if tasks.isEmpty { self.retire(identifier) }
        }
    }

    public func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        guard let identifier = session.configuration.identifier, urlSessions[identifier] === session else { return }
        urlSessions[identifier] = nil
    }
}
