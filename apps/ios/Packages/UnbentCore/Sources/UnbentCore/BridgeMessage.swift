import Foundation

/// What a page tells the app. Mirrors `AppMessage` in apps/web/src/app-bridge.ts.
///
/// From the site the app hosts: `theme` with the page's ground colour as `background`, for
/// the strips behind the status bar and the home indicator; `unauthorized` when the page
/// believes the session is gone, which the app checks before believing; `signed-out` when
/// the person signed out on the page; `app-settings` to open the app's own settings; and
/// `edge-to-edge` when the page keeps itself clear of the safe area and may have the whole
/// screen.
///
/// From the indexing page a capture hosts: `ready`, then the counts with `index-done` or
/// `message` with `index-error`.
///
/// Unknown types are ignored rather than failing, so a page from a newer deploy can say
/// something this build has never heard of without breaking the screen around it.
///
/// The Android app's half is `NoteBridge.kt`.
public struct BridgeMessage: Decodable, Equatable, Sendable {
    public let type: String
    public let indexed: Int?
    public let unusable: Int?
    public let failed: Int?
    public let message: String?
    public let background: String?

    public var isReady: Bool { type == "ready" }
    public var isUnauthorized: Bool { type == "unauthorized" }
    public var isIndexDone: Bool { type == "index-done" }
    public var isIndexError: Bool { type == "index-error" }
    public var isSignedOut: Bool { type == "signed-out" }
    public var isAppSettings: Bool { type == "app-settings" }
    public var isEdgeToEdge: Bool { type == "edge-to-edge" }
    public var themeBackground: String? { type == "theme" ? background : nil }

    /// The message in `json`, or nil for anything that is not one.
    public static func parse(_ json: String) -> BridgeMessage? {
        try? JSONDecoder().decode(BridgeMessage.self, from: Data(json.utf8))
    }
}

/// The page's ground colour, as the shell reads it to paint the strips around the page.
///
/// Only the six-digit hex the site sends. Anything else is ignored rather than painted, so
/// a page from a newer deploy that sends something else leaves the system's own background
/// showing instead of black.
public struct PageColour: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init?(hex value: String) {
        var hex = Substring(value.trimmingCharacters(in: .whitespaces))
        if hex.hasPrefix("#") { hex = hex.dropFirst() }
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit), let rgb = UInt32(hex, radix: 16) else { return nil }
        red = Double((rgb >> 16) & 0xff) / 255
        green = Double((rgb >> 8) & 0xff) / 255
        blue = Double(rgb & 0xff) / 255
    }

    /// Whether this ground wants light text over it: the clock and the battery, which the
    /// system draws on top of the strip the app paints in this colour.
    ///
    /// Relative luminance, as WCAG defines it. The page's theme usually follows the phone's
    /// and the status bar would then be right by default, but the page is what is on
    /// screen, and asking it is right even when the two disagree.
    public var isDark: Bool {
        func linear(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        return luminance < 0.5
    }
}
