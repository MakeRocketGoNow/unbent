import XCTest
@testable import UnbentCore

/// Reading the credential out of a sign-in response.
///
/// Every case here is a way the wrong cookie could be stored: the session-data cache that
/// Better Auth sets beside the session, a deletion that carries the session's own name, or
/// a name guessed for the wrong kind of origin. Ported from `SessionCookieTest.kt`, with
/// the cases only `URLSession` needs at the end.
final class SessionCookieTests: XCTestCase {

    func testPicksTheSessionOutOfEverythingASignInSets() {
        let headers = [
            "better-auth.session_data=eyJzZXNzaW9uIjp7fX0; Max-Age=300; Path=/; HttpOnly; SameSite=Lax",
            "better-auth.session_token=abc123.c2ln; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
        ]
        XCTAssertEqual(
            SessionCookie(name: "better-auth.session_token", value: "abc123.c2ln"),
            SessionCookie.fromSetCookie(headers)
        )
    }

    func testKeepsTheSecurePrefixAnHttpsInstanceUses() {
        let headers = [
            "__Secure-better-auth.session_token=abc.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
        ]
        XCTAssertEqual("__Secure-better-auth.session_token", SessionCookie.fromSetCookie(headers)?.name)
    }

    func testADeletionIsNotASession() {
        XCTAssertNil(SessionCookie.fromSetCookie(["better-auth.session_token=; Max-Age=0; Path=/; HttpOnly"]))
    }

    func testADeletionWithAStaleValueIsNotASessionEither() {
        XCTAssertNil(SessionCookie.fromSetCookie(["better-auth.session_token=old.sig; Max-Age=0; Path=/; HttpOnly"]))
    }

    func testNothingSetMeansNothingFound() {
        XCTAssertNil(SessionCookie.fromSetCookie([]))
    }

    func testTheBearerCredentialIsTheSignedValueAsSet() {
        XCTAssertEqual("abc.sig", SessionCookie(name: "n", value: "abc.sig").bearer)
    }

    func testMarksTheCookieSecureOnlyOnAnHttpsOrigin() {
        let cookie = SessionCookie(name: "__Secure-better-auth.session_token", value: "abc.sig")
        let https = cookie.setCookieLine(origin: "https://unbent.app")
        let http = cookie.setCookieLine(origin: "http://localhost:5173")

        XCTAssertTrue(https.hasPrefix("__Secure-better-auth.session_token=abc.sig; Path=/; HttpOnly"))
        XCTAssertTrue(https.hasSuffix("; Secure"))
        // The name keeps its prefix either way; only the attribute is conditional.
        XCTAssertFalse(http.hasSuffix("; Secure"))
        XCTAssertTrue(http.hasSuffix("; Path=/; HttpOnly"))
    }

    /// What the web view's cookie store is handed: the page must not be able to read it,
    /// and it must go to the instance's host and nowhere wider.
    func testTheCookieForAWebViewIsHttpOnlyAndBoundToTheHost() {
        let secure = SessionCookie(name: "__Secure-better-auth.session_token", value: "abc.sig")
            .httpCookie(origin: "https://unbent.example")
        XCTAssertEqual("__Secure-better-auth.session_token", secure?.name)
        XCTAssertEqual("abc.sig", secure?.value)
        XCTAssertEqual("unbent.example", secure?.domain)
        XCTAssertEqual("/", secure?.path)
        XCTAssertEqual(true, secure?.isHTTPOnly)
        XCTAssertEqual(true, secure?.isSecure)

        let local = SessionCookie(name: "better-auth.session_token", value: "abc.sig")
            .httpCookie(origin: "http://localhost:5204")
        XCTAssertEqual("localhost", local?.domain)
        XCTAssertEqual(true, local?.isHTTPOnly)
        XCTAssertEqual(false, local?.isSecure)
    }

    /// `URLSession` joins a response's `Set-Cookie` headers with commas, and an `Expires`
    /// date has one of its own.
    func testSeveralCookiesJoinedIntoOneHeaderComeApartAgain() {
        let joined = [
            "better-auth.session_data=eyJ9; Max-Age=300; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
            "better-auth.session_token=abc.sig; Max-Age=2592000; Expires=Fri, 20 Nov 2026 07:28:00 GMT; Path=/; HttpOnly",
            "better-auth.state=; Max-Age=0; Path=/",
        ].joined(separator: ", ")

        let lines = SessionCookie.splitSetCookie(joined)

        XCTAssertEqual(3, lines.count)
        XCTAssertTrue(lines[0].contains("Expires=Wed, 21 Oct 2026 07:28:00 GMT"))
        XCTAssertEqual(
            SessionCookie(name: "better-auth.session_token", value: "abc.sig"),
            SessionCookie.fromSetCookie(lines)
        )
    }

    func testAJoinedDeletionIsStillADeletion() {
        let joined = "better-auth.session_token=; Max-Age=0; Path=/, better-auth.session_data=; Max-Age=0; Path=/"
        XCTAssertNil(SessionCookie.fromSetCookie(SessionCookie.splitSetCookie(joined)))
    }
}
