import Foundation

/// One request a capture makes: the note, or one of its files.
public enum CaptureStep: Equatable, Sendable {
    case create
    /// A file, by the id it will have on the server (`CaptureJob.File.id`).
    case file(String)
}

/// How a request ended, reduced to what decides the next move.
public struct CaptureOutcome: Equatable, Sendable {
    /// The response's status, or nil when there was none: the request never got an answer.
    public var status: Int?
    public var retryAfter: String?
    /// Whether the session the request was sent with is still the one this phone holds.
    /// A request can wait a day before it is sent, and the page can replace the session
    /// meanwhile (see `WebShellController.installSession`), so a 401 for an old one says
    /// nothing about the person being signed out.
    public var currentSession: Bool
    /// What the server said with a 402, which is the only answer whose words decide
    /// anything (`CaptureRefusal`). Nil for every other status, and for a 402 whose body
    /// did not arrive.
    public var body: Data?

    public init(status: Int?, retryAfter: String? = nil, currentSession: Bool = true, body: Data? = nil) {
        self.status = status
        self.retryAfter = retryAfter
        self.currentSession = currentSession
        self.body = body
    }
}

/// Why the server would not take a capture that there is nothing wrong with: the account
/// has no room for it. A 402, with a `code` in its body that says which room.
///
/// Apart from every other 4xx because the answer changes when the person acts. A name
/// the server will not take is refused the same way however often it is sent, so that
/// capture is given up on; a plan that has ended is not, the moment someone subscribes or
/// deletes their way under the free plan. So a refused capture is kept, like one waiting
/// for a sign-in, and its notification says which of these it was and opens the Plan
/// page, which has the numbers. It used to say "Could not save" and delete what was
/// shared, which read as the app being broken to the one person who could have fixed it.
///
/// The web app keeps a refused write for the same reason (`plan-refused.ts` and
/// `store-full.ts` there). The Android app's half is `CaptureRefusal.kt`.
public enum CaptureRefusal: String, Codable, Equatable, Sendable {
    /// `PLAN_INACTIVE`: no plan holding, and more kept than the free plan allows. Read-only.
    case planEnded
    /// `FREE_NOTES_FULL`: a free account at its count of notes. Only a new note is refused.
    case freeNotesFull
    /// `STORAGE_FULL` of files: the plan's storage has no room for this file.
    case storageFull
    /// `STORAGE_FULL` of notes: the notes themselves take more room than the plan allows.
    case notesFull
    /// A 402 that names none of those: a code from a server newer than this build, or a
    /// body that never arrived. Still the plan's refusal and still answered on the Plan
    /// page, so it is kept like the rest and says the least it can be sure of.
    case plan

    /// The refusal an outcome is, or nil for any failure that is not the plan's.
    public static func of(_ outcome: CaptureOutcome) -> CaptureRefusal? {
        guard outcome.status == 402 else { return nil }
        let said = outcome.body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        switch said?["code"] as? String {
        case "PLAN_INACTIVE": return .planEnded
        case "FREE_NOTES_FULL": return .freeNotesFull
        case "STORAGE_FULL": return said?["of"] as? String == "notes" ? .notesFull : .storageFull
        default: return .plan
        }
    }
}

/// What to do after an outcome. The job has already been changed to match.
public enum CaptureAction: Equatable, Sendable {
    /// Nothing: other requests of this capture are still out.
    case wait
    /// Send these now.
    case send([CaptureStep])
    /// Send this again, no sooner than `after` seconds from now. `unavailable` when the
    /// server asked for the wait, which the person is told about: it can be hours.
    case retry(CaptureStep, after: TimeInterval, unavailable: Bool)
    /// Everything landed. Clear the files and say "Saved".
    case saved
    /// The session is gone. Forget it and say so. The capture is kept as it is, like one
    /// made while signed out, and goes again after the next sign-in.
    case signInNeeded
    /// The plan has no room for it. Say which room; the capture is kept as it is, and
    /// goes again when the app is next opened (`CaptureQueue.resumeAll`). `again` when it
    /// had been refused before and this is the same news, which is then said quietly.
    case refused(CaptureRefusal, again: Bool)
    /// The note could not be made. Delete the files and say so.
    case failed
}

/// A capture, from Save to the note it became: what was shared, where it goes, and how
/// far the upload has got. Kept as `.job.json` in the capture's directory.
///
/// Android keeps this in three places (WorkManager's input data, a `.note-id` sidecar and
/// a `.unavailable` count) because WorkManager runs the upload from the top on every
/// retry and the worker has to work out where it was. Here nothing runs from the top: the
/// system uploads one request at a time and wakes the app with each result, so the record
/// is a state the results are applied to, and that is a pure function with tests
/// (`handle`). The ports of `CaptureResumeTest` and `UploadWorkerTest` are tests of it.
///
/// Two ids make every request safe to send twice, which a queue that survives the app
/// being killed will do. The note's is chosen here and sent with `POST /api/notes`, which
/// answers a second request with the note the first made. Each file's is sent as
/// `X-Attachment-Id`, which does the same for an upload. That is why there is no
/// `.note-id` to write after the server answers, and no listing of the note's files
/// before uploading, both of which Android needs.
public struct CaptureJob: Codable, Equatable, Sendable {
    public struct Progress: Codable, Equatable, Sendable {
        /// Tries that failed for a reason of their own.
        public var attempts = 0
        /// Tries the server turned away with a 503 that said when to come back. Counted
        /// apart, because they are not spent: see `CaptureJob.waitsOut`.
        public var unavailable = 0

        public init() {}
    }

    public struct File: Codable, Equatable, Sendable {
        /// The id the file will have on the server. A UUID, lowercase.
        public var id: String
        /// Its name in the capture's directory, and on the note.
        public var name: String
        public var contentType: String
        public var done = false
        /// True for a file that was given up on: refused for good, or out of tries. It is
        /// `done` as well, so the rest of the capture goes on without it, and "Saved"
        /// says how many could not be added. Optional so a record written before the
        /// field existed still reads.
        public var failed: Bool?
        public var progress = Progress()

        public init(id: String = CaptureJob.newId(), name: String, contentType: String) {
            self.id = id
            self.name = name
            self.contentType = contentType
        }
    }

    /// A shared web page the server is asked to read and keep as the note, pictures and
    /// all (`POST /api/clip`), in place of a note holding its address.
    ///
    /// Set at Save for a share that is one web address and nothing else (`CaptureIntake.
    /// pageUrl`), and cleared by `handle` when the server answers that it cannot have the
    /// page, after which the same `.create` step makes the plain note the capture always
    /// made. One step rather than two because the request's label, and so the result
    /// that comes back to another process days later, names a step and not a route; and
    /// the fallback is the same note with the same chosen id, so a clip that landed
    /// unheard and a resend that then fell back meet at one note. Optional, so a record
    /// written before this existed reads as a plain note.
    ///
    /// The Android app's half is `UploadWorker`'s `pageUrl` and `clipFallsBack`.
    public struct Clip: Codable, Equatable, Sendable {
        public var url: String
        /// The title the person typed over the derived one, which the clip then keeps in
        /// place of the page's own. Nil for the page's.
        public var title: String?

        public init(url: String, title: String? = nil) {
            self.url = url
            self.title = title
        }
    }

    /// The capture's own id: its directory, and its notification.
    public var id: String
    /// The instance it was shared to. Kept with the capture, so pointing a debug build
    /// somewhere else before the upload finishes does not send it there.
    public var origin: String
    /// The id the note will have. A UUID, lowercase.
    public var noteId: String
    public var title: String
    public var body: String
    /// Nil means the Inbox.
    public var notebook: String?
    public var tags: [String]
    public var files: [File]
    /// The page to read in place of the plain note; see `Clip`.
    public var clip: Clip?
    /// Whether the server has answered that the note exists.
    public var created = false
    public var progress = Progress()
    /// Why the plan refused this capture, while it is waiting on the person to make room
    /// (`CaptureRefusal`). Set by the refusal and cleared when the note is taken (a
    /// capture refused at a file keeps it until it is saved and gone), so it also says a
    /// resend is a second asking, which shows no "Saving…".
    /// Optional so a record written before the field existed still reads.
    public var refused: CaptureRefusal?
    /// When it was last refused, and how many times it has been; see `refusedWait`.
    public var refusedAt: Date?
    public var refusedCount: Int?
    /// When it was first refused, which how long it is kept counts from (`keptLongEnough`).
    public var refusedSince: Date?
    /// The background session the extension started this capture's upload in, which the
    /// app joins to hear how it went. Nil for a capture nothing has been sent for yet,
    /// and for one made in the app.
    public var shareSession: String?

    public init(
        id: String = CaptureJob.newId(),
        origin: String,
        noteId: String = CaptureJob.newId(),
        title: String,
        body: String = "",
        notebook: String? = nil,
        tags: [String] = [],
        files: [File] = [],
        clip: Clip? = nil
    ) {
        self.id = id
        self.origin = origin
        self.noteId = noteId
        self.title = title
        self.body = body
        self.notebook = notebook
        self.tags = tags
        self.files = files
        self.clip = clip
    }

    /// Lowercase, because the API's `uuid()` check is of the form JavaScript writes and
    /// Foundation writes capitals.
    public static func newId() -> String { UUID().uuidString.lowercased() }

    // MARK: - The state machine

    /// Four tries of a request before the capture is given up on. Android's number.
    static let maxAttempts = 4

    /// How many of `maxAttempts` may be spent asking for the page. The rest make the plain
    /// note, because the failures `clipFallsBack` cannot see are often about the page too:
    /// a site that hangs past every timeout, or an article that ends the Worker for its
    /// CPU, which the edge answers with a bare 5xx. Those fail the same way on every try,
    /// and giving up after four would lose a link a one-row create would have kept. The
    /// same id on all of them, so a clip that landed unheard meets the create at one note.
    /// Android's half is `UploadWorker.clipsOnAttempt`.
    static let clipAttempts = 2

    /// How many times a request waits for a server that asked it to: fourteen, Android's
    /// number, though it buys more here. WorkManager's backoff tops out at five hours,
    /// so fourteen there is about a day; here each wait is as long as the server asked
    /// for, up to `longestWait`. Either way it is past a full day, which is the longest
    /// the case this exists for can last: the database's daily read allowance, spent
    /// until midnight UTC.
    static let maxUnavailable = 14

    static let shortestWait: TimeInterval = 60
    static let longestWait: TimeInterval = 6 * 60 * 60

    /// Whether a failure is one to wait out rather than spend an attempt on: a 503 that
    /// says when to come back. Not every 503: "reading images is not set up" fails the
    /// same way on every try, and the edge's own error page for a Worker that ran out of
    /// resources is not this server asking for time. Nor a `Retry-After` on anything
    /// else. Ported from `UploadWorker.waitsOut`.
    public static func waitsOut(_ outcome: CaptureOutcome) -> Bool {
        outcome.status == 503 && outcome.retryAfter != nil
    }

    /// How long the server asked for, held between a minute and six hours.
    ///
    /// `Retry-After` is seconds or a date. The floor is for a server that says "0"; the
    /// ceiling for one that says a week, since the system holds the request until then
    /// and nothing shorter of a new share would send it sooner.
    public static func wait(retryAfter: String?, now: Date = Date()) -> TimeInterval {
        var seconds = shortestWait
        if let text = retryAfter?.trimmingCharacters(in: .whitespaces) {
            if let number = TimeInterval(text) {
                seconds = number
            } else {
                let format = DateFormatter()
                format.locale = Locale(identifier: "en_US_POSIX")
                format.timeZone = TimeZone(identifier: "GMT")
                format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
                if let date = format.date(from: text) { seconds = date.timeIntervalSince(now) }
            }
        }
        return min(max(seconds, shortestWait), longestWait)
    }

    /// Whether an answer will be the same however often it is asked for: a 4xx, which is
    /// the server refusing the request as it stands (a name it will not take, a file
    /// too large, a note that is gone). Four are not that: 401 is about the session and
    /// 402 about the plan, both handled before this, 408 is a timeout, and 429 is "later".
    ///
    /// The web app's outbox has the same rule (`NonRetriableError`), for the same reason:
    /// trying again is four uploads of a file to hear one answer.
    static func isPermanent(_ outcome: CaptureOutcome) -> Bool {
        guard let status = outcome.status, (400..<500).contains(status) else { return false }
        return ![401, 408, 429].contains(status)
    }

    /// Whether a clip the server refused is one to make the plain note for instead: the
    /// answers the server gives about the page. 413 is a page larger than it will read,
    /// 415 a reply that is not HTML (a PDF, an image), 502 a site that refused or failed,
    /// and 400 an address it does not fetch (a private network, a loopback). Each is the
    /// server saying it cannot have this page, and the link is still worth keeping.
    ///
    /// 404 is the server saying it has no clipper at all: an instance whose operator has
    /// not switched it on (`WEB_CLIP`, answered as `CLIP_OFF`) and an instance deployed
    /// before the route existed, which answers a missing route the same way. Both are the
    /// plain note this capture always made, so the app does not read `/api/config` first
    /// to find out: that is a request on every share to save one on the rare instance
    /// without the clipper, and the 404 says the same thing.
    ///
    /// A 400 can also be the request itself (a title too long), which the create then
    /// repeats and is refused the same way: one request more, in a rare case. The queue
    /// keeps an answer's body only for a 402 (`CaptureOutcome.body`), so the `code` that
    /// would tell the two apart is nothing this reads; Android could, and uses the same
    /// five statuses all the same, so that two phones never fall back on different
    /// answers to the same page. Not a 402, which is the plan and refuses the fallback the same
    /// way, and nothing `handle` already decides (401, a 503 with `Retry-After`).
    public static func clipFallsBack(_ outcome: CaptureOutcome) -> Bool {
        guard let status = outcome.status else { return false }
        return [400, 404, 413, 415, 502].contains(status)
    }

    /// How long a capture the plan refused is kept: thirty days from its first refusal,
    /// ended by the first refusal after that. Long enough to subscribe, or to delete
    /// down to the free plan, without the scan that prompted it having gone; not for
    /// good, since each asking costs the server a request and a kept scan costs the
    /// phone its size.
    ///
    /// Decided at a refusal, never by the sweep (`CaptureStore.sweepAbandoned` leaves a
    /// refused capture twice as long): the launch sweep runs before anything is sent, so
    /// it deleted a capture on the very opening of the app that was to have sent it.
    /// Android's half is `KeptCapture.expired`.
    static let keptLongEnough: TimeInterval = 30 * 24 * 60 * 60

    /// The quiet spell after a capture's first refusal, and the longest it grows to.
    static let refusedQuiet: TimeInterval = 15 * 60
    static let refusedQuietMax: TimeInterval = 6 * 60 * 60

    /// The quiet spell after a capture's `count`th refusal: a quarter of an hour,
    /// doubling, to six hours.
    ///
    /// A fixed quarter of an hour was first. It is right for the person adding storage,
    /// who is back within it, and wrong for the account that simply stays full: that one
    /// uploaded the same scan four times in every hour the app was in use, for as long
    /// as it was used. Doubling leaves the first few askings close together and settles
    /// at four a day.
    static func quiet(count: Int) -> TimeInterval {
        min(refusedQuiet * pow(2, Double(min(max(count, 1), 16) - 1)), refusedQuietMax)
    }

    /// How long a capture the plan refused waits before it is sent again, when the app
    /// has come forward (`CaptureQueue.resumeAll`): nothing for most, and the rest of a
    /// quiet spell for the two that are dear to ask about.
    ///
    /// A note that was refused is a few hundred bytes, and goes every time: someone back
    /// from subscribing should not wait. Two captures cost more. One refused at a file
    /// uploads the whole file to hear the answer, a scan of tens of megabytes over a
    /// phone connection; and a clip has the server fetch and read someone else's page
    /// before the store refuses it. The app comes forward often (after Notification
    /// Center, after a system sheet), so those two wait out `quiet(count:)` from their
    /// last refusal first. The request is handed to the system with that wait on it
    /// rather than held back, so it goes when the wait ends without the app being opened
    /// a second time.
    ///
    /// Asking the server for the plan first was the other way. It answers a different
    /// question for each of the four refusals (a state, a count of notes, two sizes of
    /// room), and the write itself is the only check that is never out of step with the
    /// rule it checks. Android's half is `CaptureWork.refusedWaitMs`.
    public func refusedWait(now: Date = Date()) -> TimeInterval {
        // A refusal "in the future" is a clock that was set back, not a reason to wait
        // until the wall time catches up with it.
        guard refused != nil, created || clip != nil, let refusedAt, refusedAt <= now else { return 0 }
        return max(0, Self.quiet(count: refusedCount ?? 1) - now.timeIntervalSince(refusedAt))
    }

    private mutating func forgetRefusal() {
        refused = nil
        refusedAt = nil
        refusedCount = nil
        refusedSince = nil
    }

    /// Thirty seconds, doubling: WorkManager's backoff, which Android's worker runs on.
    static func backoff(attempts: Int) -> TimeInterval {
        30 * pow(2, Double(max(attempts, 1) - 1))
    }

    /// Applies how a request ended, and says what to do next.
    public mutating func handle(_ step: CaptureStep, _ outcome: CaptureOutcome, now: Date = Date()) -> CaptureAction {
        if let status = outcome.status, (200..<300).contains(status) {
            // The note was taken: there is room now, whatever was said before. Not for a
            // file, since several are out at once and one landing after another's
            // refusal says nothing about the refused one, which is still waiting.
            if step == .create { forgetRefusal() }
            switch step {
            case .create:
                // Twice is possible (the extension's request and the app's own resend
                // both answered) and the second finds nothing left to start.
                if created { return remaining.isEmpty ? .saved : .wait }
                created = true
                return remaining.isEmpty ? .saved : .send(remaining.map { .file($0.id) })
            case .file(let id):
                mark(id) { $0.done = true }
                return remaining.isEmpty && created ? .saved : .wait
            }
        }

        if outcome.status == 401, outcome.currentSession {
            // The session is gone, not merely unreachable. Retrying cannot fix it, and
            // nothing is counted against the capture: it is not the capture's failure.
            //
            // Android deletes the capture here and says "share again", and this did too.
            // But a session carries no expiry this app can read, so someone who shares
            // often and opens the app rarely finds out it lapsed only by sharing, and
            // for a scan opened from a scanner's app, the staged copy may be the only one.
            //
            // A capture the plan had refused waits for the sign-in now, not for room:
            // left marked, the resend after signing in passed it over, and "Sign in to
            // finish saving" was not true of it until the app was next opened.
            forgetRefusal()
            return .signInNeeded
        }

        if let refusal = CaptureRefusal.of(outcome) {
            // The plan has ended or is full. Like the 401 above, it is not the capture's
            // failure and nothing is counted against it: what landed stays landed, a clip
            // stays a clip, and the same requests go again once there may be room. Before
            // the clip's fallback and `isPermanent`, both of which would otherwise have it:
            // the plain note is refused the same way, and giving up deletes the files.
            let again = refused != nil
            let since = refusedSince ?? now
            // Thirty days of asking is enough; see `keptLongEnough`.
            guard now.timeIntervalSince(since) <= Self.keptLongEnough else { return .failed }
            refused = refusal
            refusedAt = now
            refusedCount = (refusedCount ?? 0) + 1
            refusedSince = since
            return .refused(refusal, again: again)
        }

        if step == .create, clip != nil, Self.clipFallsBack(outcome) {
            // The page could not be read; the link is still worth a note, which is what
            // this capture made before the route existed. Sent at once and not counted
            // as a try: it is the server's decision about the page, not a failure of the
            // request, and the plain note has what is left of its four tries.
            clip = nil
            return .send([.create])
        }

        var progress = self.progress(of: step)
        defer { setProgress(progress, of: step) }

        if Self.waitsOut(outcome) {
            progress.unavailable += 1
            guard progress.unavailable <= Self.maxUnavailable else { return .failed }
            return .retry(step, after: Self.wait(retryAfter: outcome.retryAfter), unavailable: true)
        }

        progress.attempts += 1
        guard progress.attempts < Self.maxAttempts, !Self.isPermanent(outcome) else {
            switch step {
            case .create:
                return .failed
            case .file(let id):
                // The note exists and the other files are fine. Giving the whole capture
                // up here deleted them and said "Could not save" about a note that was
                // on the server; this file alone is left out, and "Saved" says so.
                mark(id) {
                    $0.done = true
                    $0.failed = true
                }
                return remaining.isEmpty ? .saved : .wait
            }
        }
        if step == .create, clip != nil, progress.attempts >= Self.clipAttempts { clip = nil }
        // A 401 for a session that has since been replaced goes again at once, with the
        // new one; everything else backs off.
        let delay = outcome.status == 401 ? 0 : Self.backoff(attempts: progress.attempts)
        return .retry(step, after: delay, unavailable: false)
    }

    /// A file that is not in the directory any more cannot be recovered by retrying. It
    /// is skipped rather than failing the whole capture and losing the others.
    public mutating func skip(_ fileId: String) -> CaptureAction {
        mark(fileId) { $0.done = true }
        return remaining.isEmpty && created ? .saved : .wait
    }

    /// The requests this capture still needs that nothing is carrying: what to send when
    /// the app finds the capture on disk. `live` is the requests the system still holds.
    public func pending(live: Set<CaptureStep.Key>) -> [CaptureStep] {
        guard created else { return live.contains(CaptureStep.create.key(job: id)) ? [] : [.create] }
        return remaining.map { CaptureStep.file($0.id) }.filter { !live.contains($0.key(job: id)) }
    }

    /// True once the note exists and every file is on it or has been given up on.
    public var isSaved: Bool { created && remaining.isEmpty }

    /// How many files were given up on.
    public var filesNotAdded: Int { files.filter { $0.failed == true }.count }

    public func file(_ id: String) -> File? { files.first { $0.id == id } }

    private var remaining: [File] { files.filter { !$0.done } }

    private mutating func mark(_ fileId: String, _ change: (inout File) -> Void) {
        guard let index = files.firstIndex(where: { $0.id == fileId }) else { return }
        change(&files[index])
    }

    private func progress(of step: CaptureStep) -> Progress {
        switch step {
        case .create: progress
        case .file(let id): file(id)?.progress ?? Progress()
        }
    }

    private mutating func setProgress(_ value: Progress, of step: CaptureStep) {
        switch step {
        case .create: progress = value
        case .file(let id): mark(id) { $0.progress = value }
        }
    }

    // MARK: - On disk

    /// Both start with a dot because a shared filename is sanitised to strip a leading
    /// dot, so neither can collide with a file this capture is about to upload.
    static let recordName = ".job.json"
    static let createBodyName = ".create.json"

    public static func load(from directory: URL) -> CaptureJob? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(recordName)) else { return nil }
        return try? JSONDecoder().decode(CaptureJob.self, from: data)
    }

    /// Written whole and swapped in, so a process killed mid-write leaves the old record
    /// rather than half of a new one.
    public func save(to directory: URL) throws {
        let data = try JSONEncoder().encode(self)
        try data.write(to: directory.appendingPathComponent(Self.recordName), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

public extension CaptureStep {
    /// A step of one capture as text: what a request is labelled with, so the result
    /// that comes back (possibly to another process, days later) says what it was for.
    typealias Key = String

    func key(job: String) -> Key {
        switch self {
        case .create: "\(job)|create"
        case .file(let id): "\(job)|file|\(id)"
        }
    }

    /// The capture and the step a label names, or nil for anything else.
    static func parse(_ key: Key?) -> (job: String, step: CaptureStep)? {
        let parts = (key ?? "").split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        if parts.count == 2, parts[1] == "create", !parts[0].isEmpty { return (parts[0], .create) }
        if parts.count == 3, parts[1] == "file", !parts[0].isEmpty, !parts[2].isEmpty { return (parts[0], .file(parts[2])) }
        return nil
    }
}

/// The requests a capture makes, as the system's uploader is handed them: a request and a
/// file for its body, since a background session takes nothing else.
public enum CaptureRequests {
    /// `POST /api/notes`, and the JSON it carries; or, for a capture that is a page to
    /// read (`CaptureJob.Clip`), `POST /api/clip` with the page's address in place of
    /// the body, and a title only where the person typed one, since the page's own is
    /// nearly always the better name. Both carry the id the note will have, which is
    /// what lets either be sent twice, and what lets a clip that fell back find the note
    /// the unheard clip made.
    public static func create(_ job: CaptureJob, bearer: String) throws -> (request: URLRequest, body: Data) {
        guard let url = URL(string: job.origin + (job.clip == nil ? "/api/notes" : "/api/clip")) else { throw URLError(.badURL) }
        var payload: [String: Any] = ["id": job.noteId]
        if let clip = job.clip {
            payload["url"] = clip.url
            if let title = clip.title { payload["title"] = title }
        } else {
            payload["title"] = job.title
            payload["body"] = job.body
        }
        if !job.tags.isEmpty { payload["tags"] = job.tags }
        if let notebook = job.notebook { payload["notebook"] = notebook }
        var request = authorized(url, origin: job.origin, bearer: bearer)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        // The only request here that waits on someone else's site: the server gives the page
        // sixty seconds a hop and its pictures about as long again, with nothing sent back
        // meanwhile. The default sixty seconds ended first, so the 502 for a site that hung
        // was never heard. Android's is `UnbentApi.clipClient`.
        if job.clip != nil { request.timeoutInterval = 180 }
        return (request, try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
    }

    /// `PUT /api/notes/:id/files?link=1`, whose body is the staged file.
    ///
    /// `link=1` has the server write the file's link into the note, since this client has
    /// neither the note's body nor a cursor in it; `X-Attachment-Id` is what makes a
    /// second send find the file the first one stored instead of storing `scan-2.pdf`
    /// and linking it again.
    public static func upload(_ file: CaptureJob.File, of job: CaptureJob, bearer: String) throws -> URLRequest {
        guard let url = URL(string: "\(job.origin)/api/notes/\(job.noteId)/files?link=1") else { throw URLError(.badURL) }
        var request = authorized(url, origin: job.origin, bearer: bearer)
        request.httpMethod = "PUT"
        request.setValue(file.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(file.id, forHTTPHeaderField: "X-Attachment-Id")
        // Percent-encoded because a header may not carry non-ASCII, and filenames do.
        // The set is `encodeURIComponent`'s, since the server undoes it with
        // `decodeURIComponent`. `.alphanumerics` was here first and is every Unicode
        // letter, which left é, CJK and the ’ that iOS types for an apostrophe raw in
        // the header: garbled on arrival, or refused, and a refusal ended the capture.
        request.setValue(
            file.name.addingPercentEncoding(withAllowedCharacters: unreserved) ?? file.name,
            forHTTPHeaderField: "X-Filename"
        )
        return request
    }

    /// What JavaScript's `encodeURIComponent` leaves alone. ASCII only.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    private static func authorized(_ url: URL, origin: String, bearer: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        // Better Auth rejects a request without a trusted Origin as CSRF.
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return request
    }
}
