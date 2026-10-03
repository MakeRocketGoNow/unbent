import XCTest
@testable import UnbentCore

/// What goes into the Keychain item, and that a session belongs to one instance.
///
/// The Keychain itself is not exercised here: an item in an access group needs an app's
/// entitlements, which a test run on the Mac does not have. That half is checked in the
/// simulator, by signing in and relaunching.
final class SessionStoreTests: XCTestCase {

    func testTheItemIsTheNameAndTheValueAsJson() throws {
        let session = SessionCookie(name: "__Secure-better-auth.session_token", value: "abc.sig")
        let data = try XCTUnwrap(SessionStore.encode(session))

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(["name": "__Secure-better-auth.session_token", "value": "abc.sig"], object)
        XCTAssertEqual(session, SessionStore.decode(data))
    }

    func testAnItemThatIsNotASessionReadsAsSignedOut() {
        XCTAssertNil(SessionStore.decode(Data("abc.sig".utf8)))
        XCTAssertNil(SessionStore.decode(Data(#"{"name":"n"}"#.utf8)))
    }

    /// Pointing the app at another instance must not send the old one's credential there,
    /// and pointing it back finds the old session where it was left.
    func testASessionIsKeptPerInstance() {
        let store: SessionStoring = MemorySessionStore()
        let session = SessionCookie(name: "better-auth.session_token", value: "abc.sig")

        XCTAssertTrue(store.save(session, for: "https://unbent.example/"))
        XCTAssertEqual(session, store.session(for: "https://unbent.example"))
        XCTAssertNil(store.session(for: "http://localhost:5204"))

        store.clear(for: "http://localhost:5204")
        XCTAssertEqual(session, store.session(for: "unbent.example"))
        store.clear(for: "https://unbent.example")
        XCTAssertNil(store.session(for: "https://unbent.example"))
    }
}
