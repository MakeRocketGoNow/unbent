import Foundation

/// What this build was configured with, read out of Info.plist — which is where the
/// values in `Config/*.xcconfig` end up. Swift has no `BuildConfig`; this is it.
enum BuildInfo {
    /// The instance the app opens until told otherwise: `UNBENT_INSTANCE_SCHEME` and
    /// `UNBENT_INSTANCE_HOST`, put back together.
    static let defaultInstance = "\(string("UnbentInstanceScheme") ?? "https")://\(string("UnbentInstanceHost") ?? "unbent.app")"

    /// The scheme a browser sign-in comes back on. Registered now; used by MAK-155.
    static let connectScheme = string("UnbentConnectScheme") ?? "unbent"

    /// The App Group, shared with the Share Extension. Also the Keychain access group.
    static let appGroup = string("UnbentAppGroup")

    static let version = string("CFBundleShortVersionString") ?? "0"
    static let build = string("CFBundleVersion") ?? "0"

    /// The hosts the web view may open, or nil for a build with no such list — one made
    /// without `WKAppBoundDomains`, which may then open any address and has no service
    /// worker.
    static let appBoundHosts: [String]? = {
        guard let hosts = Bundle.main.object(forInfoDictionaryKey: "WKAppBoundDomains") as? [String] else { return nil }
        // The list is written by build settings, and a fork's may name the same host twice.
        var seen = Set<String>()
        return hosts.map { $0.lowercased() }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }()

    /// Whether this is the debug build: the one that may be pointed at another instance,
    /// and that shows the sign-in methods it cannot use yet.
    static var isDebug: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    private static func string(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else { return nil }
        return value
    }
}
