import Foundation

/// Trims a typed address to a bare origin.
///
/// People type "unbent.app", "https://unbent.app/", sometimes with a path from a copied
/// link. Everything downstream concatenates "/api/…", so a trailing slash or a stray path
/// produces a URL that 404s in a way that looks like a server fault.
public func normalizeOrigin(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return trimmed }
    let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    guard let url = URLComponents(string: withScheme), let scheme = url.scheme, let host = url.host, !host.isEmpty else {
        var bare = Substring(withScheme)
        while bare.hasSuffix("/") { bare = bare.dropLast() }
        return String(bare)
    }
    let port = url.port.map { ":\($0)" } ?? ""
    return "\(scheme)://\(host)\(port)"
}

/// An instance as a person would name it: the host, and the port when it has one.
///
/// The scheme is left out for every instance, not only https ones. Three screens each
/// stripped `https://` by hand, so production read `unbent.app` while a dev server beside
/// it read `http://localhost:5204` — the same line in two shapes, for no reason anyone
/// chose. An address that will not parse is shown as it was given.
public func displayHost(_ origin: String) -> String {
    guard let url = URLComponents(string: normalizeOrigin(origin)), let host = url.host, !host.isEmpty else {
        return origin
    }
    return url.port.map { "\(host):\($0)" } ?? host
}

/// What the app remembers that is not a secret: which Unbent it talks to, and where the
/// last capture was filed.
///
/// In the App Group's defaults rather than the app's own, so the Share Extension reads the
/// same instance the app is pointed at. The session is not here; it is a credential and
/// lives in the Keychain (`SessionStore`).
///
/// The Android app's half is `Prefs.kt`.
public final class AppPrefs {
    private let defaults: UserDefaults
    private let defaultInstance: String

    /// - Parameter defaultInstance: where the app signs in until told otherwise — the
    ///   build's `UNBENT_INSTANCE_SCHEME` and `UNBENT_INSTANCE_HOST`.
    public init(defaults: UserDefaults, defaultInstance: String) {
        self.defaults = defaults
        self.defaultInstance = normalizeOrigin(defaultInstance)
    }

    /// Origin of the instance, normalized, never with a trailing slash.
    public var instance: String {
        get { defaults.string(forKey: Self.instanceKey) ?? defaultInstance }
        set { defaults.set(normalizeOrigin(newValue), forKey: Self.instanceKey) }
    }

    /// Forgets a chosen instance, so the build's own is used again.
    public func resetInstance() {
        defaults.removeObject(forKey: Self.instanceKey)
    }

    /// Where the last capture was filed, offered first by the next one.
    ///
    /// A share sheet is used in runs — five receipts in a row go to the same place — and
    /// the notebook picked last time is the likeliest answer. Per origin like the session,
    /// since a notebook name belongs to one instance's account.
    public var lastNotebook: String? {
        get { defaults.string(forKey: lastNotebookKey) }
        set {
            if let newValue { defaults.set(newValue, forKey: lastNotebookKey) } else { defaults.removeObject(forKey: lastNotebookKey) }
        }
    }

    private var lastNotebookKey: String { "lastNotebook:\(instance)" }
    private static let instanceKey = "instance"
}
