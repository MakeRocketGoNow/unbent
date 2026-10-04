import Foundation
import UnbentCore

/// What the app and the Share Extension both reach for, made the same way in each: the
/// instance, the session, and the place captures wait. Two processes that built these
/// differently would be two apps that disagree about who is signed in to what.
enum Captures {
    /// The App Group's defaults, so both read the same instance. The fallback is only for
    /// a build with no group named at all.
    static func prefs() -> AppPrefs {
        let defaults = BuildInfo.appGroup.flatMap(UserDefaults.init(suiteName:)) ?? .standard
        return AppPrefs(defaults: defaults, defaultInstance: BuildInfo.defaultInstance)
    }

    static func sessions() -> SessionStore {
        SessionStore(accessGroup: BuildInfo.appGroup)
    }

    /// The instance in use. Only a debug build's can be anything but the one it was built
    /// for: the web view opens its App-Bound Domains and nothing else, and a release
    /// build has exactly one.
    static func instance(_ prefs: AppPrefs) -> String {
        BuildInfo.isDebug ? prefs.instance : normalizeOrigin(BuildInfo.defaultInstance)
    }

    /// Where captures wait, or nil for a build signed without the App Group — which has
    /// no directory both processes can read, and so no captures.
    static func store() -> CaptureStore? {
        guard
            let group = BuildInfo.appGroup,
            let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { return nil }
        return CaptureStore(container: container)
    }
}
