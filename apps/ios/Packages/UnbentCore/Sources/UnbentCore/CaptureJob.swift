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

    public init(status: Int?, retryAfter: String? = nil, currentSession: Bool = true) {
        self.status = status
        self.retryAfter = retryAfter
        self.currentSession = currentSession
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
    /// Out of attempts. Delete the files and say so.
    case failed
}

/// A capture, from Save to the note it became: what was shared, where it goes, and how
/// far the upload has got. Kept as `.job.json` in the capture's directory.
///
/// Android keeps this in three places — WorkManager's input data, a `.note-id` sidecar and
/// a `.unavailable` count — because WorkManager runs the upload from the top on every
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
        public var progress = Progress()

        public init(id: String = CaptureJob.newId(), name: String, contentType: String) {
            self.id = id
            self.name = name
            self.contentType = contentType
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
    /// Whether the server has answered that the note exists.
    public var created = false
    public var progress = Progress()
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
        files: [File] = []
    ) {
        self.id = id
        self.origin = origin
        self.noteId = noteId
        self.title = title
        self.body = body
        self.notebook = notebook
        self.tags = tags
        self.files = files
    }

    /// Lowercase, because the API's `uuid()` check is of the form JavaScript writes and
    /// Foundation writes capitals.
    public static func newId() -> String { UUID().uuidString.lowercased() }

    // MARK: - The state machine

    /// Four tries of a request before the capture is given up on. Android's number.
    static let maxAttempts = 4

    /// How many times a request waits for a server that asked it to: fourteen, Android's
    /// number, though it buys more here. WorkManager's backoff tops out at five hours,
    /// so fourteen there is about a day; here each wait is as long as the server asked
    /// for, up to `longestWait`. Either way it is past a full day, which is the longest
    /// the case this exists for can last — the database's daily read allowance, spent
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

    /// Thirty seconds, doubling: WorkManager's backoff, which Android's worker runs on.
    static func backoff(attempts: Int) -> TimeInterval {
        30 * pow(2, Double(max(attempts, 1) - 1))
    }

    /// Applies how a request ended, and says what to do next.
    public mutating func handle(_ step: CaptureStep, _ outcome: CaptureOutcome) -> CaptureAction {
        if let status = outcome.status, (200..<300).contains(status) {
            switch step {
            case .create:
                // Twice is possible — the extension's request and the app's own resend
                // both answered — and the second finds nothing left to start.
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
            // often and opens the app rarely finds out it lapsed only by sharing — and
            // for a scan opened from a scanner's app, the staged copy may be the only one.
            return .signInNeeded
        }

        var progress = self.progress(of: step)
        defer { setProgress(progress, of: step) }

        if Self.waitsOut(outcome) {
            progress.unavailable += 1
            guard progress.unavailable <= Self.maxUnavailable else { return .failed }
            return .retry(step, after: Self.wait(retryAfter: outcome.retryAfter), unavailable: true)
        }

        progress.attempts += 1
        guard progress.attempts < Self.maxAttempts else { return .failed }
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

    /// True once the note exists and every file is on it.
    public var isSaved: Bool { created && remaining.isEmpty }

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
    /// that comes back — possibly to another process, days later — says what it was for.
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
    /// `POST /api/notes`, and the JSON it carries.
    public static func create(_ job: CaptureJob, bearer: String) throws -> (request: URLRequest, body: Data) {
        guard let url = URL(string: job.origin + "/api/notes") else { throw URLError(.badURL) }
        var payload: [String: Any] = ["id": job.noteId, "title": job.title, "body": job.body]
        if !job.tags.isEmpty { payload["tags"] = job.tags }
        if let notebook = job.notebook { payload["notebook"] = notebook }
        var request = authorized(url, origin: job.origin, bearer: bearer)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
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
