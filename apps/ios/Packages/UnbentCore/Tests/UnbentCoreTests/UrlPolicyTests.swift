import XCTest
@testable import UnbentCore

/// Which addresses stay in the web view. Everything that does runs with the app's session
/// and bridge, so the cases below are mostly about what must *not* stay: the same host on
/// another scheme or port, a host that merely starts like this one, and a protocol-relative
/// path. Ported from `UrlPolicyTest.kt`.
final class UrlPolicyTests: XCTestCase {
    private let site = "https://unbent.example"

    func testTheSitesOwnPagesStay() {
        XCTAssertEqual(.inApp, classify(origin: site, url: "https://unbent.example/notes/abc?view=table"))
        XCTAssertEqual(.inApp, classify(origin: site, url: "https://UNBENT.example/settings"))
        XCTAssertEqual(.inApp, classify(origin: site, url: "https://unbent.example:443/notes"))
    }

    func testAnOriginWrittenWithATrailingSlashIsTheSameSite() {
        XCTAssertEqual(.inApp, classify(origin: "https://unbent.example/", url: "https://unbent.example/notes"))
    }

    func testTheSameHostOnAnotherSchemeOrPortIsAnotherSite() {
        XCTAssertEqual(.browser("http://unbent.example/notes"), classify(origin: site, url: "http://unbent.example/notes"))
        XCTAssertEqual(.browser("https://unbent.example:8443/"), classify(origin: site, url: "https://unbent.example:8443/"))
    }

    func testALocalInstanceIsItsOwnPort() {
        let local = "http://localhost:5232"
        XCTAssertEqual(.inApp, classify(origin: local, url: "http://localhost:5232/notes"))
        XCTAssertEqual(.browser("http://localhost:8787/notes"), classify(origin: local, url: "http://localhost:8787/notes"))
        XCTAssertEqual(.browser("http://localhost/notes"), classify(origin: local, url: "http://localhost/notes"))
    }

    func testALookalikeHostLeaves() {
        XCTAssertEqual(
            .browser("https://unbent.example.attacker.test/"),
            classify(origin: site, url: "https://unbent.example.attacker.test/")
        )
        XCTAssertEqual(.browser("https://evil.example/x"), classify(origin: site, url: "https://evil.example/x"))
    }

    func testWhatThePageMadeItselfStays() {
        XCTAssertEqual(.inApp, classify(origin: site, url: "about:blank"))
        XCTAssertEqual(.inApp, classify(origin: site, url: "blob:https://unbent.example/1234"))
    }

    func testAnythingThatIsNotAWebPageGoesToTheSystem() {
        XCTAssertEqual(.other("mailto:someone@example.com"), classify(origin: site, url: "mailto:someone@example.com"))
        XCTAssertEqual(.other("tel:+15555550100"), classify(origin: site, url: "tel:+15555550100"))
        XCTAssertEqual(.other("intent://x#Intent;end"), classify(origin: site, url: "intent://x#Intent;end"))
    }

    /// A link to the site opens on the instance the app is pointed at, matched by host so a
    /// shared https link still opens in a debug build pointed at a laptop on http.
    func testALinkToTheSiteBecomesAPathOnTheAppsInstance() {
        XCTAssertEqual("/notes/abc?view=table", linkPath(instance: site, link: "https://unbent.example/notes/abc?view=table#top"))
        XCTAssertEqual("/notes", linkPath(instance: "http://unbent.example:5232", link: "https://unbent.example/notes"))
        XCTAssertEqual("/", linkPath(instance: site, link: "https://unbent.example"))
    }

    func testALinkToAnotherSiteIsNotTheApps() {
        XCTAssertNil(linkPath(instance: site, link: "https://other.example/notes/abc"))
        XCTAssertNil(linkPath(instance: "https://my-own.example", link: "https://unbent.example/notes/abc"))
        XCTAssertNil(linkPath(instance: site, link: "mailto:someone@unbent.example"))
    }

    /// A `_blank` to this site is a path for `inAppWindowPath`, which the shell opens in
    /// place. Loading it into the web view would replace the app.
    func testANewWindowToThisSiteIsAPathToOpenInPlace() {
        XCTAssertEqual("/notes/abc?view=table", inAppWindowPath(origin: site, url: "https://unbent.example/notes/abc?view=table"))
        XCTAssertEqual("/settings", inAppWindowPath(origin: site, url: "https://unbent.example/settings"))
        XCTAssertEqual("/", inAppWindowPath(origin: site, url: "https://unbent.example/"))
    }

    func testANewWindowOffTheSiteOrOneThePageMadeIsNotAPath() {
        XCTAssertNil(inAppWindowPath(origin: site, url: "https://evil.example/notes"))
        XCTAssertNil(inAppWindowPath(origin: site, url: "http://unbent.example/notes"))
        XCTAssertNil(inAppWindowPath(origin: site, url: "mailto:someone@example.com"))
        XCTAssertNil(inAppWindowPath(origin: site, url: "about:blank"))
        XCTAssertNil(inAppWindowPath(origin: site, url: "javascript:alert(1)"))
        XCTAssertNil(inAppWindowPath(origin: site, url: "blob:https://unbent.example/1234"))
    }

    func testOnlyAPathOnThisSiteIsFollowed() {
        XCTAssertTrue(isSitePath("/notes/abc"))
        XCTAssertFalse(isSitePath("//evil.example/notes"))
        XCTAssertFalse(isSitePath("https://evil.example/"))
        XCTAssertFalse(isSitePath(""))
    }

    func testAPageBouncedToSignInGoesBackWhereItWas() {
        XCTAssertEqual("/notes/abc", returnPath(current: "https://unbent.example/login?redirect=%2Fnotes%2Fabc", fallback: "/notes"))
        XCTAssertEqual(
            "/notes?view=table",
            returnPath(current: "https://unbent.example/login?x=1&redirect=%2Fnotes%3Fview%3Dtable", fallback: "/notes")
        )
    }

    func testAnythingElseGoesToTheList() {
        XCTAssertEqual("/notes", returnPath(current: nil, fallback: "/notes"))
        XCTAssertEqual("/notes", returnPath(current: "about:blank", fallback: "/notes"))
        XCTAssertEqual("/notes", returnPath(current: "https://unbent.example/login", fallback: "/notes"))
        XCTAssertEqual("/notes", returnPath(current: "https://unbent.example/trash?redirect=%2Fsettings", fallback: "/notes"))
        XCTAssertEqual("/notes", returnPath(current: "https://unbent.example/login?redirect=%2F%2Fevil.example", fallback: "/notes"))
        XCTAssertEqual("/notes", returnPath(current: "https://unbent.example/login?redirect=https%3A%2F%2Fevil.example", fallback: "/notes"))
        XCTAssertEqual("/notes", returnPath(current: "https://unbent.example/login?redirect=%2Flogin%3Fredirect%3D%2Fx", fallback: "/notes"))
    }
}
