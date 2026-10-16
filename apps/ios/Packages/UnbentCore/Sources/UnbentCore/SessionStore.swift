import Foundation
import Security

/// Where the session is kept between launches. A protocol so a screen can be given one
/// that holds nothing but memory.
public protocol SessionStoring: AnyObject {
    func session(for origin: String) -> SessionCookie?
    /// Throws when the session could not be kept. A sign-in that cannot be kept is not one
    /// the app can act on, and has to be said rather than shown as a screen that resets;
    /// the error is whatever the store has to say about why.
    func save(_ session: SessionCookie, for origin: String) throws
    func clear(for origin: String)
}

/// The session, in the Keychain, one item per instance.
///
/// Android keeps its copy in app-private preferences and says why that is enough there. On
/// iOS the Keychain is the ordinary place for a credential and costs nothing extra, and it
/// answers the one thing preferences cannot: the Share Extension is a second process that
/// needs the same session, and an item in the App Group's access group is readable by both
/// and by nothing else.
///
/// Per origin, like Android's: pointing the app at a different instance must not send the
/// old instance's credential to it, and pointing it back finds the old session where it was
/// left.
///
/// `AfterFirstUnlockThisDeviceOnly`, both halves deliberate. After first unlock, because
/// the extension uploads in the background while the phone is locked in a pocket. This
/// device only, because a session is tied to a sign-in on this phone; restored onto another
/// from a backup it would be a second device nobody signed in on.
public final class SessionStore: SessionStoring {
    private let accessGroup: String?

    /// - Parameter accessGroup: the App Group, which is also a Keychain access group. Nil
    ///   keeps items in the app's own group, where no extension can read them.
    public init(accessGroup: String?) {
        self.accessGroup = accessGroup
    }

    public func session(for origin: String) -> SessionCookie? {
        var query = base(origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return Self.decode(data)
    }

    /// The likeliest failure is a build signed without the App Group: the access group is
    /// then one the app has no entitlement for, and the Keychain refuses the item
    /// (`errSecMissingEntitlement`). The error carries the Keychain's own status.
    public func save(_ session: SessionCookie, for origin: String) throws {
        guard let data = Self.encode(session) else { throw KeychainError(status: errSecParam) }
        // Delete and add rather than update: an update cannot change an item's
        // accessibility, and an item written by an older build keeps whatever it had.
        SecItemDelete(base(origin) as CFDictionary)
        var item = base(origin)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear(for origin: String) {
        SecItemDelete(base(origin) as CFDictionary)
    }

    private func base(_ origin: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: normalizeOrigin(origin),
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    static let service = "unbent.session"

    /// `{name, value}` as JSON. The name is kept beside the value because it is part of
    /// what was learned from the server, not something to guess again when the cookie is
    /// put back into a web view.
    static func encode(_ session: SessionCookie) -> Data? {
        try? JSONEncoder().encode(session)
    }

    static func decode(_ data: Data) -> SessionCookie? {
        try? JSONDecoder().decode(SessionCookie.self, from: data)
    }
}

/// The Keychain refusing something, with the status it gave. The number is what gets
/// looked up (`-34018` is a missing entitlement) so it is in the description as well as
/// the system's sentence for it, which is often no more than "the operation failed".
public struct KeychainError: Error, Equatable, CustomStringConvertible {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }

    public var description: String {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error"
        return "\(message) (\(status))"
    }
}

/// A session kept only as long as the object: previews, and tests of the screens.
public final class MemorySessionStore: SessionStoring {
    private var sessions: [String: SessionCookie] = [:]

    public init() {}

    public func session(for origin: String) -> SessionCookie? { sessions[normalizeOrigin(origin)] }
    public func save(_ session: SessionCookie, for origin: String) { sessions[normalizeOrigin(origin)] = session }
    public func clear(for origin: String) { sessions[normalizeOrigin(origin)] = nil }
}
