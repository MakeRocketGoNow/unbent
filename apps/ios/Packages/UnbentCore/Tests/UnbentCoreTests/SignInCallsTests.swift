import XCTest
@testable import UnbentCore

/// The two sign-ins that are only requests. The password cases are ported from
/// `PasswordAuthTest.kt`; the code ones follow the same shape.
final class SignInCallsTests: XCTestCase {

    override func setUp() {
        StubServer.reset()
    }

    private var password: PasswordAuth { PasswordAuth(origin: StubServer.origin, session: StubServer.session()) }
    private var code: EmailOtpAuth { EmailOtpAuth(origin: StubServer.origin, session: StubServer.session()) }

    func testSignInPostsTheCredentialsWithAnOriginAndKeepsTheCookieTheResponseSet() async throws {
        StubServer.enqueue(.init(
            headers: ["Set-Cookie": "better-auth.session_token=sess.sig; Max-Age=2592000; Path=/; HttpOnly"],
            body: #"{"token":"sess","user":{"id":"u1"}}"#
        ))

        let session = try await password.signIn(email: "me@example.com", password: "hunter22")

        XCTAssertEqual(SessionCookie(name: "better-auth.session_token", value: "sess.sig"), session)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("POST", asked.method)
        XCTAssertEqual("/api/auth/sign-in/email", asked.path)
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        XCTAssertEqual(#"{"email":"me@example.com","password":"hunter22"}"#, asked.body)
    }

    func testSignUpCarriesTheNameBetterAuthRequires() async throws {
        StubServer.enqueue(.init(headers: ["Set-Cookie": "better-auth.session_token=sess.sig; Path=/; HttpOnly"]))

        _ = try await password.signUp(email: "me@example.com", password: "hunter22", name: "Me")

        let asked = try StubServer.takeRequest()
        XCTAssertEqual("/api/auth/sign-up/email", asked.path)
        XCTAssertTrue(asked.body.contains(#""name":"Me""#))
    }

    func testARefusalKeepsTheServersWordsSoTheAllowlistCanExplainItself() async throws {
        StubServer.enqueue(.init(
            status: 403,
            body: #"{"code":"SIGNUPS_CLOSED","message":"This Unbent instance is not open for sign-ups."}"#
        ))

        do {
            _ = try await password.signUp(email: "stranger@example.com", password: "hunter22", name: "Stranger")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(403, error.status)
            XCTAssertEqual("This Unbent instance is not open for sign-ups.", error.serverMessage())
        }
    }

    func testASuccessThatSetsNoCookieIsNotASignIn() async throws {
        StubServer.enqueue(.init(body: #"{"token":"sess"}"#))

        do {
            _ = try await password.signIn(email: "me@example.com", password: "hunter22")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertTrue(error.message.contains("no session"))
        }
    }

    func testAskingForACodeSaysItIsForSigningIn() async throws {
        StubServer.enqueue(.init(body: #"{"success":true}"#))

        try await code.sendCode(email: "me@example.com")

        let asked = try StubServer.takeRequest()
        XCTAssertEqual("/api/auth/email-otp/send-verification-otp", asked.path)
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        XCTAssertEqual(#"{"email":"me@example.com","type":"sign-in"}"#, asked.body)
    }

    /// Where the instance checks a Turnstile token with the request (MAK-243), the token
    /// goes in the header the server's plugin reads; where it asks for none, none is sent.
    func testAskingForACodeCarriesTheTurnstileTokenOnlyWhenGivenOne() async throws {
        StubServer.enqueue(.init(body: #"{"success":true}"#))
        try await code.sendCode(email: "me@example.com")
        XCTAssertNil(try StubServer.takeRequest().headers["x-captcha-response"])

        StubServer.enqueue(.init(body: #"{"success":true}"#))
        try await code.sendCode(email: "me@example.com", captchaToken: "tok-1")
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("tok-1", asked.headers["x-captcha-response"])
        XCTAssertEqual(#"{"email":"me@example.com","type":"sign-in"}"#, asked.body)
    }

    /// The session arrives beside other cookies, joined into one header the way
    /// `URLSession` hands them over.
    func testACodeIsTradedForTheSessionAmongEverythingElseTheResponseSets() async throws {
        StubServer.enqueue(.init(headers: [
            "Set-Cookie": [
                "__Secure-better-auth.session_data=eyJ9; Max-Age=300; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; Secure",
                "__Secure-better-auth.session_token=sess.sig; Max-Age=2592000; Path=/; HttpOnly; Secure",
            ].joined(separator: ", "),
        ]))

        let session = try await code.signIn(email: "me@example.com", code: "123456")

        XCTAssertEqual(SessionCookie(name: "__Secure-better-auth.session_token", value: "sess.sig"), session)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("/api/auth/sign-in/email-otp", asked.path)
        XCTAssertEqual(#"{"email":"me@example.com","otp":"123456"}"#, asked.body)
    }

    func testAWrongCodeIsARefusalWithTheServersWords() async throws {
        StubServer.enqueue(.init(status: 400, body: #"{"code":"INVALID_OTP","message":"Invalid OTP"}"#))

        do {
            _ = try await code.signIn(email: "me@example.com", code: "000000")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(400, error.status)
            XCTAssertEqual("Invalid OTP", error.serverMessage())
        }
    }
}
