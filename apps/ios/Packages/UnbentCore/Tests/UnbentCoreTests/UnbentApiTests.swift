import XCTest
@testable import UnbentCore

/// The API as the native screens call it. Ported from `UnbentApiTest.kt`.
final class UnbentApiTests: XCTestCase {
    private var api: UnbentApi!

    override func setUp() {
        StubServer.reset()
        api = UnbentApi(origin: StubServer.origin, bearer: "sess.sig", session: StubServer.session())
    }

    func testAFieldTheServerAddsLaterDoesNotBreakDecoding() async throws {
        StubServer.enqueue(.init(body: #"{"providers":["google","email-otp"],"somethingNew":{"a":1}}"#))

        let config = try await UnbentApi(origin: StubServer.origin, bearer: nil, session: StubServer.session()).config()

        XCTAssertTrue(config.google)
        XCTAssertTrue(config.emailOtp)
        XCTAssertFalse(config.password)
        // Before sign-in there is no credential to send.
        XCTAssertNil(try StubServer.takeRequest().headers["Authorization"])
    }

    /// The site key is there only where the instance has the check on; an older instance
    /// sends nothing and decodes as none.
    func testTheConfigNamesTheTurnstileSiteKeyOnlyWhereTheCheckIsOn() throws {
        let on = try JSONDecoder().decode(AppConfig.self, from: Data(#"{"providers":["email-otp"],"turnstile":{"siteKey":"1x00"}}"#.utf8))
        XCTAssertEqual(TurnstileConfig(siteKey: "1x00"), on.turnstile)
        let off = try JSONDecoder().decode(AppConfig.self, from: Data(#"{"providers":["email-otp"]}"#.utf8))
        XCTAssertNil(off.turnstile)
    }

    /// Google and Apple have sheets of their own on a phone; every other provider shares
    /// the browser, however many the instance turned on.
    func testOnlyProvidersWithNoSheetOfTheirOwnCountAsBrowserSocials() {
        let config = AppConfig(providers: ["google", "apple", "github", "discord", "passkey", "email-otp", "password"])
        XCTAssertEqual(2, config.browserSocials)
        XCTAssertTrue(config.apple)
        XCTAssertTrue(config.passkey)
    }

    func testMeReportsNoUserRatherThanFailingWhenTheSessionIsGone() async throws {
        StubServer.enqueue(.init(body: #"{"user":null}"#))
        let gone = try await api.me()
        XCTAssertNil(gone)

        StubServer.enqueue(.init(body: #"{"user":{"id":"u1","email":"me@example.com"}}"#))
        let user = try await api.me()
        XCTAssertEqual("me@example.com", user?.email)
        XCTAssertEqual("", user?.name)
    }

    func testListsNotebooksAndTags() async throws {
        StubServer.enqueue(.init(body: #"{"notebooks":[{"id":"b1","name":"Coupons","count":3},{"id":"b2","name":"Podcast Bookmarks"}],"unfiled":7}"#))
        let notebooks = try await api.listNotebooks()
        XCTAssertEqual(["Coupons", "Podcast Bookmarks"], notebooks.notebooks.map(\.name))
        XCTAssertEqual(0, notebooks.notebooks[1].count)
        XCTAssertEqual(7, notebooks.unfiled)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("/api/notebooks", asked.path)
        // Every call says who it is and where it comes from; Better Auth refuses one
        // without a trusted Origin as CSRF.
        XCTAssertEqual("Bearer sess.sig", asked.headers["Authorization"])
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        XCTAssertNil(asked.headers["Cookie"])

        StubServer.enqueue(.init(body: #"{"tags":[{"name":"tax","count":2}]}"#))
        let tags = try await api.listTags()
        XCTAssertEqual(["tax"], tags.map(\.name))
        XCTAssertEqual("/api/tags", try StubServer.takeRequest().path)
    }

    func testAFailedCallSurfacesItsStatusSo401CanBeToldApart() async throws {
        StubServer.enqueue(.init(status: 401, body: #"{"error":"unauthorized"}"#))

        do {
            _ = try await api.listNotebooks()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(401, error.status)
        }
    }

    func testTheServersOwnExplanationIsReadableFromARefusal() async throws {
        StubServer.enqueue(.init(status: 409, body: #"{"error":"A notebook with that name already exists."}"#))

        do {
            _ = try await api.listNotebooks()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual("A notebook with that name already exists.", error.serverMessage())
        }
        XCTAssertNil(ApiError(status: 500, message: "x", body: "<html>").serverMessage())
        XCTAssertNil(ApiError(status: 500, message: "x", body: #"{"message":""}"#).serverMessage())
    }

    func testARefusalCarriesTheServersRetryAfterAndOneWithoutItCarriesNone() async throws {
        StubServer.enqueue(.init(status: 503, headers: ["Retry-After": "3600"], body: "{}"))
        do {
            _ = try await api.me()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual("3600", error.retryAfter)
        }

        StubServer.enqueue(.init(status: 503, body: "{}"))
        do {
            _ = try await api.me()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertNil(error.retryAfter)
        }
    }

    /// The shell tells a server that refused from a phone with no signal by this: no
    /// answer at all is not an `ApiError`.
    func testNoAnswerIsNotAnApiError() async throws {
        do {
            _ = try await api.me()
            XCTFail("expected an error")
        } catch {
            XCTAssertFalse(error is ApiError)
            XCTAssertTrue(error is URLError)
        }
    }
}
