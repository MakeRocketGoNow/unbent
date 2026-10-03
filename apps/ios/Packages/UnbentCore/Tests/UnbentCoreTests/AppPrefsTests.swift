import XCTest
@testable import UnbentCore

/// Address normalization, and what is remembered per instance.
///
/// Everything downstream builds URLs by concatenating "/api/…", so a trailing slash or a
/// pasted path produces a 404 that looks like a server fault rather than a typo. The
/// normalization cases are ported from `PrefsTest.kt`.
final class AppPrefsTests: XCTestCase {

    func testAddsHttpsWhenTheSchemeIsMissing() {
        XCTAssertEqual("https://unbent.app", normalizeOrigin("unbent.app"))
    }

    func testDropsATrailingSlash() {
        XCTAssertEqual("https://unbent.app", normalizeOrigin("https://unbent.app/"))
    }

    func testDropsAPastedPath() {
        XCTAssertEqual("https://unbent.app", normalizeOrigin("https://unbent.app/notes/abc"))
    }

    func testKeepsAnExplicitPortWhichLocalDevNeeds() {
        XCTAssertEqual("http://localhost:5173", normalizeOrigin("http://localhost:5173"))
    }

    func testTrimsSurroundingWhitespace() {
        XCTAssertEqual("https://unbent.app", normalizeOrigin("  unbent.app  "))
    }

    func testLeavesAnEmptyStringEmptyRatherThanInventingAHost() {
        XCTAssertEqual("", normalizeOrigin("   "))
    }

    /// One shape for every instance: the scheme never shows, the port does when there is one.
    func testAnInstanceIsShownAsItsHostAndPort() {
        XCTAssertEqual("unbent.app", displayHost("https://unbent.app"))
        XCTAssertEqual("localhost:5204", displayHost("http://localhost:5204"))
        XCTAssertEqual("notes.example.com:8443", displayHost("https://notes.example.com:8443/"))
        XCTAssertEqual("unbent.app", displayHost("unbent.app"))
        XCTAssertEqual("", displayHost(""))
    }

    private func prefs() -> AppPrefs {
        let suite = "unbent.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return AppPrefs(defaults: defaults, defaultInstance: "https://unbent.example")
    }

    func testTheBuildsInstanceIsUsedUntilAnotherIsChosen() {
        let prefs = prefs()
        XCTAssertEqual("https://unbent.example", prefs.instance)

        prefs.instance = "localhost:5204/notes"
        XCTAssertEqual("https://localhost:5204", prefs.instance)

        prefs.resetInstance()
        XCTAssertEqual("https://unbent.example", prefs.instance)
    }

    /// A notebook name belongs to one instance's account, so the one remembered for a
    /// laptop's dev server is not offered against the real one.
    func testTheLastNotebookIsRememberedPerInstance() {
        let prefs = prefs()
        prefs.lastNotebook = "Coupons"

        prefs.instance = "http://localhost:5204"
        XCTAssertNil(prefs.lastNotebook)
        prefs.lastNotebook = "Podcast Bookmarks"

        prefs.resetInstance()
        XCTAssertEqual("Coupons", prefs.lastNotebook)
        prefs.lastNotebook = nil
        XCTAssertNil(prefs.lastNotebook)
    }
}
