import XCTest
@testable import UnbentCore

/// The requests either side of the browser, Apple's sheet and the passkey sheet. The
/// connect cases are ported from `ConnectAuthTest.kt`; Apple and passkeys have no Kotlin
/// half to port, since Android hands both to a library.
final class NativeSignInTests: XCTestCase {

    override func setUp() {
        StubServer.reset()
    }

    private let sessionLine = "better-auth.session_token=sess-abc.sig; Max-Age=2592000; Path=/; HttpOnly"
    private let signedIn = SessionCookie(name: "better-auth.session_token", value: "sess-abc.sig")

    // MARK: - The browser

    private var connect: ConnectAuth { ConnectAuth(origin: StubServer.origin, session: StubServer.session()) }

    func testTheConnectUrlCarriesTheAppsOwnRedirectEncoded() throws {
        let url = try XCTUnwrap(connect.connectUrl(scheme: "unbent")).absoluteString
        XCTAssertTrue(url.hasPrefix(StubServer.origin + "/connect?"))
        // Encoded, or the slashes would end the query value early.
        XCTAssertTrue(url.contains("redirect=unbent%3A%2F%2Fconnect"))
    }

    func testTheDebugBuildAsksToBeRedirectedToItsOwnScheme() throws {
        let url = try XCTUnwrap(connect.connectUrl(scheme: "unbent-debug")).absoluteString
        XCTAssertTrue(url.contains("unbent%2Ddebug%3A%2F%2Fconnect"))
        // What the page compares against its list is the decoded value.
        let redirect = URLComponents(string: url)?.queryItems?.first { $0.name == "redirect" }?.value
        XCTAssertEqual("unbent-debug://connect", redirect)
    }

    func testTheTokenIsReadOffTheAddressTheBrowserCameBackOn() throws {
        let back = try XCTUnwrap(URL(string: "unbent://connect?token=one%2Dtime%20xyz"))
        XCTAssertEqual("one-time xyz", ConnectAuth.token(from: back, scheme: "unbent"))
    }

    func testAnAddressWithNoTokenOrForAnotherSchemeCarriesNone() throws {
        XCTAssertNil(ConnectAuth.token(from: try XCTUnwrap(URL(string: "unbent://connect")), scheme: "unbent"))
        XCTAssertNil(ConnectAuth.token(from: try XCTUnwrap(URL(string: "unbent://connect?token=")), scheme: "unbent"))
        XCTAssertNil(ConnectAuth.token(from: try XCTUnwrap(URL(string: "unbent://other?token=t")), scheme: "unbent"))
        // The release build's redirect, arriving at the debug build.
        XCTAssertNil(ConnectAuth.token(from: try XCTUnwrap(URL(string: "unbent://connect?token=t")), scheme: "unbent-debug"))
    }

    func testRedeemYieldsTheSessionCookieTheResponseSetNotTheTokenInItsBody() async throws {
        StubServer.enqueue(.init(
            headers: ["Set-Cookie": sessionLine],
            body: #"{"session":{"token":"sess-abc","userId":"u1"},"user":{"id":"u1"}}"#
        ))

        let session = try await connect.redeem(token: "one-time-xyz")

        XCTAssertEqual(signedIn, session)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("POST", asked.method)
        XCTAssertEqual("/api/auth/one-time-token/verify", asked.path)
        // Better Auth rejects a request with no trusted Origin as CSRF.
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        XCTAssertEqual(#"{"token":"one-time-xyz"}"#, asked.body)
    }

    func testASpentOrForgedTokenIsReportedNotTreatedAsSuccess() async throws {
        StubServer.enqueue(.init(status: 400, body: #"{"message":"Invalid token"}"#))

        do {
            _ = try await connect.redeem(token: "already-used")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(400, error.status)
        }
    }

    func testAResponseThatSetsNoSessionCookieFailsRatherThanStoringAnEmptyCredential() async throws {
        StubServer.enqueue(.init(body: #"{"session":{"token":"sess-abc"},"user":{"id":"u1"}}"#))

        do {
            _ = try await connect.redeem(token: "odd-response")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertTrue(error.message.contains("no session"))
        }
    }

    // MARK: - Apple

    private var apple: AppleAuth { AppleAuth(origin: StubServer.origin, session: StubServer.session()) }

    /// A known answer, so the hash is checked against something other than itself: the
    /// SHA-256 of "abc", from FIPS 180-2.
    func testAppleIsGivenTheLowercaseHexSha256OfTheNonce() {
        let nonce = AppleAuth.Nonce(raw: "abc")
        XCTAssertEqual("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", nonce.hashed)
        XCTAssertEqual("abc", nonce.raw)
    }

    func testEachRequestGetsANonceOfItsOwn() {
        let one = AppleAuth.Nonce.random()
        let two = AppleAuth.Nonce.random()
        XCTAssertNotEqual(one.raw, two.raw)
        // 32 bytes, base64url: long enough to be unguessable, and safe in JSON as it is.
        XCTAssertEqual(43, one.raw.count)
        XCTAssertNotEqual(one.raw, one.hashed)
    }

    func testTheServerIsSentTheTokenWithTheNonceItselfNotTheHashAppleWasGiven() async throws {
        StubServer.enqueue(.init(headers: ["Set-Cookie": sessionLine]))
        let nonce = AppleAuth.Nonce(raw: "raw-nonce")

        let session = try await apple.signIn(identityToken: "apple.jwt.token", nonce: nonce)

        XCTAssertEqual(signedIn, session)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("/api/auth/sign-in/social", asked.path)
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        XCTAssertEqual(#"{"idToken":{"nonce":"raw-nonce","token":"apple.jwt.token"},"provider":"apple"}"#, asked.body)
        XCTAssertFalse(asked.body.contains(nonce.hashed))
    }

    /// The exchange is a sign-up where the allowlist is empty, so the instance's Turnstile
    /// check stands in front of it as in front of a code (MAK-243).
    func testTheExchangeCarriesTheTurnstileTokenOnlyWhenGivenOne() async throws {
        StubServer.enqueue(.init(headers: ["Set-Cookie": sessionLine]))
        _ = try await apple.signIn(identityToken: "apple.jwt.token", nonce: .init(raw: "n"))
        XCTAssertNil(try StubServer.takeRequest().headers["x-captcha-response"])

        StubServer.enqueue(.init(headers: ["Set-Cookie": sessionLine]))
        _ = try await apple.signIn(identityToken: "apple.jwt.token", nonce: .init(raw: "n"), captchaToken: "tok-1")
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("tok-1", asked.headers["x-captcha-response"])
        XCTAssertEqual("/api/auth/sign-in/social", asked.path)
    }

    func testAnInstanceThatDoesNotAcceptThisAppsTokensSaysSo() async throws {
        StubServer.enqueue(.init(status: 401, body: #"{"message":"Invalid id token"}"#))

        do {
            _ = try await apple.signIn(identityToken: "apple.jwt.token", nonce: .init(raw: "n"))
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual("Invalid id token", error.serverMessage())
        }
    }

    func testTheNameAppleGaveOnceIsSetAsTheSignedInAccount() async throws {
        StubServer.enqueue(.init(body: #"{"status":true}"#))

        try await apple.setName("Sam Example", session: signedIn)

        let asked = try StubServer.takeRequest()
        XCTAssertEqual("/api/auth/update-user", asked.path)
        XCTAssertEqual("Bearer sess-abc.sig", asked.headers["Authorization"])
        XCTAssertEqual(#"{"name":"Sam Example"}"#, asked.body)
    }

    func testANameIsMadeOfWhicheverPartsAppleSent() {
        XCTAssertEqual("Sam Example", AppleAuth.displayName(given: "Sam", family: "Example"))
        XCTAssertEqual("Sam", AppleAuth.displayName(given: " Sam ", family: nil))
        XCTAssertEqual("Example", AppleAuth.displayName(given: "", family: "Example"))
        // Every authorization after the first.
        XCTAssertNil(AppleAuth.displayName(given: nil, family: nil))
        XCTAssertNil(AppleAuth.displayName(given: " ", family: ""))
    }

    // MARK: - Passkeys

    private var passkey: PasskeyAuth { PasskeyAuth(origin: StubServer.origin, session: StubServer.session()) }

    func testBase64UrlReadsAndWritesTheUnpaddedForm() {
        // 0xfb 0xff: "+/8=" in base64, so both substitutions and the padding are in play.
        let bytes = Data([0xfb, 0xff])
        XCTAssertEqual("-_8", bytes.base64Url)
        XCTAssertEqual(bytes, Data(base64Url: "-_8"))
        XCTAssertEqual(bytes, Data(base64Url: "-_8="))
        XCTAssertEqual(Data(), Data(base64Url: ""))
        XCTAssertNil(Data(base64Url: "not base64!"))
    }

    func testTheChallengeIsReadWithEverythingTheServerAskedFor() async throws {
        StubServer.enqueue(.init(
            headers: ["Set-Cookie": "better-auth.better-auth-passkey=tok.sig; Max-Age=300; Path=/; HttpOnly"],
            body: #"{"challenge":"-_8","rpId":"notes.example.com","timeout":60000,"userVerification":"required","allowCredentials":[{"id":"AQID","type":"public-key"}]}"#
        ))

        let challenge = try await passkey.challenge()

        XCTAssertEqual(Data([0xfb, 0xff]), challenge.challenge)
        XCTAssertEqual("notes.example.com", challenge.relyingParty)
        XCTAssertEqual([Data([1, 2, 3])], challenge.allowCredentials)
        XCTAssertEqual("required", challenge.userVerification)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("GET", asked.method)
        XCTAssertEqual("/api/auth/passkey/generate-authenticate-options", asked.path)
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
    }

    func testAChallengeThatNamesNoRelyingPartyMeansTheInstancesOwnHost() async throws {
        StubServer.enqueue(.init(body: #"{"challenge":"AQID"}"#))

        let challenge = try await passkey.challenge()

        XCTAssertEqual("stub.test", challenge.relyingParty)
        XCTAssertEqual([], challenge.allowCredentials)
        XCTAssertNil(challenge.userVerification)
    }

    func testAChallengeThatCannotBeReadIsAFailureNotAnEmptyRequest() async throws {
        StubServer.enqueue(.init(body: #"{"rpId":"notes.example.com"}"#))

        do {
            _ = try await passkey.challenge()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertTrue(error.message.contains("could not read"))
        }
    }

    private let assertion = PasskeyAssertion(
        credentialID: Data([0xfb, 0xff]),
        clientDataJSON: Data(#"{"type":"webauthn.get"}"#.utf8),
        authenticatorData: Data([1, 2, 3]),
        signature: Data([4, 5, 6, 7]),
        userHandle: Data("user-1".utf8)
    )

    func testTheAssertionIsWebAuthnsJsonInBase64UrlThroughout() throws {
        let json = assertion.json()

        XCTAssertEqual("-_8", json["id"] as? String)
        XCTAssertEqual("-_8", json["rawId"] as? String)
        XCTAssertEqual("public-key", json["type"] as? String)
        let response = try XCTUnwrap(json["response"] as? [String: Any])
        XCTAssertEqual("eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0", response["clientDataJSON"] as? String)
        XCTAssertEqual("AQID", response["authenticatorData"] as? String)
        XCTAssertEqual("BAUGBw", response["signature"] as? String)
        XCTAssertEqual("dXNlci0x", response["userHandle"] as? String)
    }

    func testAnAssertionWithNoUserHandleLeavesItOutRatherThanSendingItEmpty() throws {
        for handle in [nil, Data()] as [Data?] {
            let bare = PasskeyAssertion(
                credentialID: Data([1]), clientDataJSON: Data([2]), authenticatorData: Data([3]), signature: Data([4]),
                userHandle: handle
            )
            let response = try XCTUnwrap(bare.json()["response"] as? [String: Any])
            XCTAssertNil(response["userHandle"])
        }
    }

    /// The whole exchange: the cookie the options set is what tells the server which
    /// challenge the answer is for, and this client has no jar to carry it.
    func testTheAnswerGoesBackWithTheCookieTheChallengeCameWith() async throws {
        StubServer.enqueue(.init(
            headers: ["Set-Cookie": [
                "__Secure-better-auth.better-auth-passkey=tok.sig; Max-Age=300; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; Secure",
                "__Secure-better-auth.state=; Max-Age=0; Path=/",
            ].joined(separator: ", ")],
            body: #"{"challenge":"AQID","rpId":"stub.test"}"#
        ))
        StubServer.enqueue(.init(headers: ["Set-Cookie": sessionLine]))

        let challenge = try await passkey.challenge()
        let session = try await passkey.verify(assertion, for: challenge)

        XCTAssertEqual(signedIn, session)
        _ = try StubServer.takeRequest()
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("POST", asked.method)
        XCTAssertEqual("/api/auth/passkey/verify-authentication", asked.path)
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        // The live cookie only: a deletion is not something to send back.
        XCTAssertEqual("__Secure-better-auth.better-auth-passkey=tok.sig", asked.headers["Cookie"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(asked.body.utf8)) as? [String: Any])
        let response = try XCTUnwrap(body["response"] as? [String: Any])
        XCTAssertEqual("-_8", response["id"] as? String)
    }

    func testAPasskeyTheServerDoesNotKnowIsARefusalWithItsWords() async throws {
        StubServer.enqueue(.init(body: #"{"challenge":"AQID","rpId":"stub.test"}"#))
        StubServer.enqueue(.init(status: 401, body: #"{"message":"Passkey not found"}"#))

        let challenge = try await passkey.challenge()
        do {
            _ = try await passkey.verify(assertion, for: challenge)
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual("Passkey not found", error.serverMessage())
        }
    }
}
