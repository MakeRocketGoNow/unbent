import Foundation

/// An API call that failed with a status, so 401 can be handled differently from the rest.
///
/// `retryAfter` is the response's `Retry-After`, when it sent one: the server's own word
/// that the failure is passing and worth waiting out. Only the session check's 503 sends
/// it — the one a spent database allowance produces — so it is what tells that apart from
/// a 503 that will fail the same way however long a capture waits.
///
/// A call that got no answer at all throws `URLError` instead, and the difference is the
/// point: this one is the server speaking.
public struct ApiError: Error, Equatable, LocalizedError {
    public let status: Int
    public let message: String
    public let body: String
    public let retryAfter: String?

    public init(status: Int, message: String, body: String = "", retryAfter: String? = nil) {
        self.status = status
        self.message = message
        self.body = body
        self.retryAfter = retryAfter
    }

    public var errorDescription: String? { message }

    /// The server's own explanation, pulled out of the JSON body this wraps.
    ///
    /// Worth surfacing because some refusals are deliberate and actionable — a sign-up
    /// allowlist rejecting an address, a notebook name already taken — and a generic "did
    /// not work" sends the person to retry something that will refuse them again for the
    /// same reason. Better Auth says `message`; this API's own routes say `error`.
    public func serverMessage() -> String? {
        guard
            let object = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
            let text = (object["message"] ?? object["error"]) as? String,
            !text.isEmpty
        else { return nil }
        return text
    }
}

/// The API, as the native screens and the share extension use it.
///
/// `config` and `me` are the app's; `listNotebooks` and `listTags` fill the capture
/// sheet. A capture's own requests are not here: they go through a background session,
/// which takes a request and a file rather than a call that waits, so they are built by
/// `CaptureRequests` instead. `BridgeMessage`'s indexing fields have no caller either,
/// and are waiting on an indexer.
///
/// The Android app's half is `UnbentApi.kt`. Calls are `async` on a `URLSession` with no
/// cookie jar: the session is sent as a bearer by hand, and a jar would let a cookie from
/// one sign-in ride along on the next person's request.
public struct UnbentApi: Sendable {
    private let origin: String
    /// Nil before sign-in, when the only call that makes sense is `config`.
    private let bearer: String?
    private let session: URLSession

    public init(origin: String, bearer: String?, session: URLSession = UnbentApi.shared) {
        self.origin = origin
        self.bearer = bearer
        self.session = session
    }

    /// The configuration every client here uses: no cookies kept or sent, and nothing
    /// cached — an answer to `/api/me` from yesterday is worse than none.
    public static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        config.timeoutIntervalForRequest = 60
        // Generous: an upload is a single large PUT over a phone radio, and a short limit
        // aborts a big PDF that is progressing perfectly well.
        config.timeoutIntervalForResource = 600
        return config
    }

    public static let shared = URLSession(configuration: configuration())

    public func config() async throws -> AppConfig {
        try await get("Config", url("/api/config"))
    }

    /// Who the stored session belongs to, or nil when the server no longer knows it.
    public func me() async throws -> MeUser? {
        let me: Me = try await get("Session check", url("/api/me"))
        return me.user
    }

    public func listNotebooks() async throws -> NotebookList {
        try await get("List notebooks", url("/api/notebooks"))
    }

    public func listTags() async throws -> [Tag] {
        let list: TagList = try await get("List tags", url("/api/tags"))
        return list.tags ?? []
    }

    // MARK: - Plumbing

    private func url(_ path: String) -> URL {
        // The origin is normalized before it is stored, so this only fails for an address
        // nobody could have signed in to; the request then fails as unreachable.
        URL(string: origin + path) ?? URL(fileURLWithPath: "/")
    }

    /// Better Auth rejects requests without a trusted `Origin` as CSRF, so every call sends
    /// one. See the note in the project README; the CLI hits the same requirement.
    private func authorized(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return request
    }

    private func get<T: Decodable>(_ what: String, _ url: URL) async throws -> T {
        try decode(await call(authorized(url), what))
    }

    private func call(_ request: URLRequest, _ what: String) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        return try Self.checked(data, response, what)
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }

    /// The body of a response that succeeded, or an `ApiError` carrying its status.
    static func checked(_ data: Data, _ response: URLResponse, _ what: String) throws -> Data {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw ApiError(
                status: http.statusCode,
                message: "\(what) failed: \(http.statusCode)",
                body: String(decoding: data, as: UTF8.self),
                retryAfter: http.value(forHTTPHeaderField: "Retry-After")
            )
        }
        return data
    }
}
