// swift-tools-version: 5.9
import PackageDescription

/*
 * Everything the iOS app knows that is not a screen: where an address opens, the session
 * and where it is kept, the API, the page's messages, and the files it saves.
 *
 * No UIKit and no WebKit, and it names macOS beside iOS for one reason: `swift test` then
 * runs on the Mac that builds it, with no simulator to boot. What it does use is on both:
 * Foundation, Security, CryptoKit, and for captures ImageIO, UniformTypeIdentifiers and
 * UserNotifications. Anything that needs a window or a sheet of the system's belongs in
 * the app target or in UnbentUI, not here.
 */
let package = Package(
    name: "UnbentCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "UnbentCore", targets: ["UnbentCore"]),
    ],
    targets: [
        .target(name: "UnbentCore"),
        .testTarget(name: "UnbentCoreTests", dependencies: ["UnbentCore"]),
    ]
)
