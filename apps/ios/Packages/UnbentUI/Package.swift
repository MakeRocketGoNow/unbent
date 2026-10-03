// swift-tools-version: 5.9
import PackageDescription

/*
 * The app's native screens, as SwiftUI views that take values and closures and know
 * nothing about where either comes from.
 *
 * A package of its own, apart from the app target, for the Share Extension: it is a second
 * target that has to draw in the same hand — the same spacing steps, the same buttons —
 * and a view compiled into the app cannot be used from it.
 */
let package = Package(
    name: "UnbentUI",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "UnbentUI", targets: ["UnbentUI"]),
    ],
    dependencies: [
        .package(path: "../UnbentCore"),
    ],
    targets: [
        .target(name: "UnbentUI", dependencies: ["UnbentCore"]),
    ]
)
