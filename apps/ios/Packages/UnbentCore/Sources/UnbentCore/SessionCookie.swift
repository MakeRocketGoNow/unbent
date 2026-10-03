import Foundation

/// The one credential this app holds: the session cookie Better Auth set when it signed in.
///
/// Stored as the cookie itself — name and signed value — rather than the bare session token
/// the JSON body also carries, because the same string serves two clients. `UnbentApi` sends
/// the value as `Authorization: Bearer`, which the API's bearer plugin accepts unchanged
/// since a signed value already carries its signature. The web view gets the cookie put
/// into its store under the same name, and so shares the session with no exchange of any
/// kind.
///
/// The name is taken from the response rather than assumed: Better Auth prefixes it with
/// `__Secure-` on https origins and not on the http origin a simulator uses to reach a dev
/// server, and a guess that got that wrong would fail only on the other kind of instance.
///
/// The Android app's half is `SessionCookie.kt`, and the two are kept the same on purpose.
public struct SessionCookie: Codable, Equatable, Sendable {
    public let name: String
    public let value: String

    public init(name: String, value: String) {
        self.name = name
        self.value = value
    }

    /// The bearer credential: the signed cookie value, exactly as the server set it.
    public var bearer: String { value }

    /// The `Set-Cookie` line that puts this session in a web view's store for `origin`.
    ///
    /// `Secure` only on https: a cookie marked Secure is silently dropped by an http origin,
    /// which is how a dev instance would end up showing a sign-in page inside the app.
    /// HttpOnly because the page has no business reading it; the bridge is how the page
    /// and the app talk.
    public func setCookieLine(origin: String) -> String {
        var line = "\(name)=\(value); Path=/; HttpOnly"
        if origin.hasPrefix("https://") { line += "; Secure" }
        return line
    }

    /// This session as a cookie for `origin`, ready for `WKHTTPCookieStore`.
    ///
    /// Made by parsing `setCookieLine` as a response header rather than from a dictionary
    /// of properties: `HTTPCookie(properties:)` has no documented key for HttpOnly, and the
    /// parser is the one path Foundation promises will honour it.
    public func httpCookie(origin: String) -> HTTPCookie? {
        guard let url = URL(string: origin) else { return nil }
        return HTTPCookie
            .cookies(withResponseHeaderFields: ["Set-Cookie": setCookieLine(origin: origin)], for: url)
            .first
    }

    private static let suffix = "session_token"

    /// Finds the session cookie among a response's `Set-Cookie` lines.
    ///
    /// A sign-in sets several: the session, the cached session data, sometimes a state
    /// cookie being cleared. The wanted one ends in `session_token` and carries a value;
    /// a `Max-Age=0` line is a deletion, not a session, whatever its name.
    public static func fromSetCookie(_ headers: [String]) -> SessionCookie? {
        for line in headers {
            let parts = line.split(separator: ";", omittingEmptySubsequences: false)
            let pair = parts.first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            guard let eq = pair.firstIndex(of: "="), eq != pair.startIndex else { continue }
            let name = pair[..<eq].trimmingCharacters(in: .whitespaces)
            let value = pair[pair.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            guard name.hasSuffix(suffix), !value.isEmpty else { continue }

            let attributes = parts.dropFirst().map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            if attributes.contains("max-age=0") { continue }

            return SessionCookie(name: name, value: value)
        }
        return nil
    }

    /// The `Set-Cookie` lines of a response, one cookie each.
    ///
    /// `URLSession` hands every header over as one value per name, so several `Set-Cookie`
    /// headers arrive joined with commas — and a cookie's own `Expires` date has a comma in
    /// it. `HTTPCookie` can parse the joined form, but it gives back cookies without their
    /// `Max-Age`, which is the one attribute that tells a deletion from a session. So the
    /// join is undone here instead: a comma starts a new cookie only where what follows
    /// reads `name=`, which the rest of a date never does.
    public static func setCookieLines(_ response: HTTPURLResponse) -> [String] {
        guard let joined = response.value(forHTTPHeaderField: "Set-Cookie") else { return [] }
        return splitSetCookie(joined)
    }

    static func splitSetCookie(_ joined: String) -> [String] {
        guard let boundary = try? NSRegularExpression(pattern: #",\s*(?=[^;,=\s]+=)"#) else { return [joined] }
        let text = joined as NSString
        var lines: [String] = []
        var start = 0
        for match in boundary.matches(in: joined, range: NSRange(location: 0, length: text.length)) {
            lines.append(text.substring(with: NSRange(location: start, length: match.range.location - start)))
            start = match.range.location + match.range.length
        }
        lines.append(text.substring(from: start))
        return lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}
