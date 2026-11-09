import XCTest
@testable import UnbentCore

/// The palette is the site's, by index, and an index the app does not know draws the
/// neutral chip rather than crashing or picking a colour of its own: the server decides.
final class TagPaletteTests: XCTestCase {
    func testTenHuesInTheStylesheetsOrder() {
        XCTAssertEqual(10, TagPalette.hues.count)
        XCTAssertEqual(0x5F9A48, TagPalette.hue(3, dark: false)) // green
        XCTAssertEqual(0x8C8781, TagPalette.hue(9, dark: false)) // grey
    }

    func testNoColourOrOneOffThePaletteIsTheNeutralChip() {
        XCTAssertEqual(TagPalette.text(dark: false), TagPalette.hue(nil, dark: false))
        XCTAssertEqual(TagPalette.text(dark: false), TagPalette.hue(10, dark: false))
        XCTAssertEqual(TagPalette.text(dark: true), TagPalette.hue(-1, dark: true))
        XCTAssertEqual(TagPalette.fill(nil, dark: false), TagPalette.fill(42, dark: false))
    }

    /// The stylesheet's own arithmetic, worked by hand: blue (#4a7fc7) at 16% over #fbfaf8
    /// is #dfe6f0, and at 70% into #1c1a17 is #3c6192.
    func testMixesAsTheStylesheetDoes() {
        XCTAssertEqual(0xDFE6F0, TagPalette.fill(5, dark: false))
        XCTAssertEqual(0x3C6192, TagPalette.ink(5, dark: false))
    }

    func testDarkWashIsDeeperAndInkStillCarriesTheHue() {
        let ground = TagPalette.ground(dark: true)
        let fill = TagPalette.fill(5, dark: true)
        XCTAssertNotEqual(ground, fill)
        let ink = TagPalette.ink(5, dark: true)
        // Blue's ink leans blue: more blue than red in it.
        XCTAssertGreaterThan(ink & 0xFF, (ink >> 16) & 0xFF)
    }
}
