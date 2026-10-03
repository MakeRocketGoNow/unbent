import CryptoKit
import Foundation

/*
 * The three ways in that put something of the phone's in front of the request: a browser,
 * Apple's sheet, and the passkey sheet. The sheets themselves are the app's
 * (`SignInSheets.swift`), since they need a window; what is here is everything either
 * side of them — the address to open, the values to hand a sheet, and the request that
 * turns what it gave back into a session — so that all of it runs under `swift test`.
 *
 * Each ends where the password and the code end: the session cookie the response set.
 *
 * The Android app's halves are `ConnectAuth.kt`, `GoogleAuth.kt` and `PasskeyAuth.kt`.
 */

/// Trading a one-time token for a session: the other half of `/connect`.
///
/// The app opens that page in the system's sign-in browser, which shares Safari's cookies,
/// so someone already signed in to the site there — by whichever provider, which is the
/// point: Google, GitHub and anything an instance adds later work without this file
/// knowing they exist — is one tap from done. The page mints a token and redirects to the
/// app's scheme, and this exchanges it for an ordinary session.
public struct ConnectAuth: Sendable {
    private let origin: String
    private let session: URLSession

    public init(origin: String, session: URLSession = UnbentApi.shared) {
        self.origin = origin
        self.session = session
    }

    /// The page to open. `redirect` is where the browser hands the token back, and has to
    /// be one of the exact strings the page allows (`ALLOWED_REDIRECTS` in connect.tsx).
    public func connectUrl(scheme: String) -> URL? {
        // Encoded by hand: `URLQueryItem` leaves `:` and `/` alone, which is legal and
        // reads to some servers as the end of the value.
        let redirect = "\(scheme)://connect".addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return URL(string: "\(origin)/connect?redirect=\(redirect)")
    }

    /// The token in the address the browser came back on, or nil when it carries none —
    /// which is the page declining, not a failure to report.
    public static func token(from callback: URL, scheme: String) -> String? {
        guard
            callback.scheme?.lowercased() == scheme.lowercased(),
            callback.host == "connect",
            let token = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "token" })?.value,
            !token.isEmpty
        else { return nil }
        return token
    }

    /// Exchanges the token for the session the response sets.
    ///
    /// The token is spent by this call — replaying it fails — so a session that does not
    /// get stored is simply lost, and the person connects again.
    public func redeem(token: String) async throws -> SessionCookie {
        try await signInCall(origin, "/api/auth/one-time-token/verify", ["token": token], "Connecting", session)
    }
}

/// Sign in with Apple, either side of Apple's sheet.
///
/// The sheet is asked for an identity token bound to a nonce, and the token goes to the
/// endpoint the site's own Apple button ends at. Its audience is this app's bundle id
/// rather than the site's Services ID, which is why an instance has to list the bundle
/// ids it accepts (`APPLE_BUNDLE_ID`; MAK-152).
public struct AppleAuth: Sendable {
    private let origin: String
    private let session: URLSession

    public init(origin: String, session: URLSession = UnbentApi.shared) {
        self.origin = origin
        self.session = session
    }

    /// A nonce for one request: what the server is sent, and what Apple is.
    ///
    /// Two forms, and which goes where is the whole of it. Apple copies whatever it is
    /// given into the token, and is given the SHA-256 of the nonce so the nonce itself
    /// never passes through Apple's sheet; the server is given the nonce, hashes it, and
    /// compares. Sending the same form to both verifies against a server that accepts
    /// either and proves nothing: a token lifted in transit would carry everything needed
    /// to replay it.
    public struct Nonce: Equatable, Sendable {
        /// For the server, beside the token.
        public let raw: String
        /// For `ASAuthorizationAppleIDRequest.nonce`: lowercase hex of SHA-256 of `raw`.
        public let hashed: String

        public init(raw: String) {
            self.raw = raw
            hashed = SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
        }

        /// Thirty-two bytes from the system's generator, as text.
        public static func random() -> Nonce {
            var generator = SystemRandomNumberGenerator()
            let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
            return Nonce(raw: Data(bytes).base64Url)
        }
    }

    /// Hands Apple's identity token to Better Auth, which checks its signature, its
    /// audience and the nonce, and signs the person in.
    public func signIn(identityToken: String, nonce: Nonce) async throws -> SessionCookie {
        try await signInCall(
            origin,
            "/api/auth/sign-in/social",
            ["provider": "apple", "idToken": ["token": identityToken, "nonce": nonce.raw]],
            "Sign in with Apple",
            session
        )
    }

    /// Gives the account the name Apple's sheet returned.
    ///
    /// Apple sends a name once, on a person's first authorization, to the app and never in
    /// the token — so the server made the account without one, and this is the only
    /// chance to fill it in. A failure is not a failed sign-in, and the caller treats it
    /// that way: the name can be set on the site.
    public func setName(_ name: String, session cookie: SessionCookie) async throws {
        var request = try post(origin, "/api/auth/update-user", ["name": name])
        request.setValue("Bearer \(cookie.bearer)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        _ = try UnbentApi.checked(data, response, "Setting the name")
    }

    /// The name out of the parts Apple gives, or nil when there is none to set.
    public static func displayName(given: String?, family: String?) -> String? {
        let name = [given, family]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return name.isEmpty ? nil : name
    }
}

/// What the server asks a passkey to sign, read out of WebAuthn's request options.
///
/// Android hands the server's JSON to Credential Manager untouched. iOS has no call that
/// takes it: the request is built from parts, so the parts are read here, and everything
/// the server sent that has a place in that request is carried — dropping
/// `allowCredentials` would offer passkeys the server will refuse, and dropping
/// `userVerification` would skip Face ID for a server that requires it.
public struct PasskeyChallenge: Equatable, Sendable {
    public let challenge: Data
    /// The relying party the passkey is bound to. A host, never an origin.
    public let relyingParty: String
    /// Empty means any passkey for the relying party, which is the usual case: the server
    /// does not know who is signing in until they have.
    public let allowCredentials: [Data]
    /// `required`, `preferred` or `discouraged`, as the server wrote it.
    public let userVerification: String?
    /// The cookie the options response set, which names the challenge to the server and
    /// has to come back with the answer.
    let cookie: String?

    public init(challenge: Data, relyingParty: String, allowCredentials: [Data] = [], userVerification: String? = nil) {
        self.init(challenge: challenge, relyingParty: relyingParty, allowCredentials: allowCredentials, userVerification: userVerification, cookie: nil)
    }

    init(challenge: Data, relyingParty: String, allowCredentials: [Data], userVerification: String?, cookie: String?) {
        self.challenge = challenge
        self.relyingParty = relyingParty
        self.allowCredentials = allowCredentials
        self.userVerification = userVerification
        self.cookie = cookie
    }
}

/// What the passkey sheet gives back: one credential's signature over the challenge.
public struct PasskeyAssertion: Equatable, Sendable {
    public let credentialID: Data
    public let clientDataJSON: Data
    public let authenticatorData: Data
    public let signature: Data
    /// The account the passkey belongs to, when the authenticator says. Absent is legal.
    public let userHandle: Data?

    public init(credentialID: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userHandle: Data?) {
        self.credentialID = credentialID
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userHandle = userHandle
    }

    /// The assertion as WebAuthn's JSON (`AuthenticationResponseJSON`), which is what the
    /// server's verifier reads.
    ///
    /// Every binary field is base64url without padding, `id` and `rawId` are the same
    /// string, and `userHandle` is left out rather than sent empty: the verifier compares
    /// a handle that is present against the account's.
    public func json() -> [String: Any] {
        var response: [String: Any] = [
            "clientDataJSON": clientDataJSON.base64Url,
            "authenticatorData": authenticatorData.base64Url,
            "signature": signature.base64Url,
        ]
        if let userHandle, !userHandle.isEmpty { response["userHandle"] = userHandle.base64Url }
        return [
            "id": credentialID.base64Url,
            "rawId": credentialID.base64Url,
            "type": "public-key",
            // A passkey kept by the phone itself. The verifier does not check it; the
            // type says it must be there.
            "authenticatorAttachment": "platform",
            "clientExtensionResults": [String: Any](),
            "response": response,
        ]
    }
}

/// Signing in with a passkey, either side of the system's sheet.
///
/// The same WebAuthn credential the site makes, offered to this app because the instance
/// vouches for it: its `apple-app-site-association` lists the app under `webcredentials`,
/// and the app claims the instance's host in its associated domains. Without both, the
/// sheet has nothing to offer for the domain.
///
/// Two round trips, both to Better Auth's own endpoints: ask for a challenge, then post
/// what the authenticator signed. The private key never leaves the Secure Enclave, and
/// this app never sees it either — it forwards an assertion.
public struct PasskeyAuth: Sendable {
    private let origin: String
    private let session: URLSession

    public init(origin: String, session: URLSession = UnbentApi.shared) {
        self.origin = origin
        self.session = session
    }

    /// The challenge. Public — it has to be, since asking for one precedes signing in.
    public func challenge() async throws -> PasskeyChallenge {
        guard let url = URL(string: origin + "/api/auth/passkey/generate-authenticate-options") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.setValue(origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await session.data(for: request)
        let body = try UnbentApi.checked(data, response, "Starting passkey sign-in")
        let cookie = (response as? HTTPURLResponse).flatMap(Self.challengeCookie)
        guard let challenge = Self.parse(body, fallbackHost: URLComponents(string: origin)?.host, cookie: cookie) else {
            throw ApiError(status: 200, message: "Passkey sign-in got a challenge it could not read.")
        }
        return challenge
    }

    /// Hands the signed assertion back for verification, and collects the session.
    ///
    /// A failure here is a real one — a credential the server does not know, or a
    /// challenge that has expired — so the server's own words are worth keeping.
    public func verify(_ assertion: PasskeyAssertion, for challenge: PasskeyChallenge) async throws -> SessionCookie {
        try await signInCall(
            origin,
            "/api/auth/passkey/verify-authentication",
            ["response": assertion.json()],
            "Passkey sign-in",
            session,
            cookie: challenge.cookie
        )
    }

    static func parse(_ body: Data, fallbackHost: String?, cookie: String?) -> PasskeyChallenge? {
        guard
            let options = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let text = options["challenge"] as? String,
            let challenge = Data(base64Url: text),
            !challenge.isEmpty,
            // The server names the relying party; one that does not means the page's own
            // host, by WebAuthn's rule, and the instance's host is this app's equivalent.
            let relyingParty = (options["rpId"] as? String) ?? fallbackHost,
            !relyingParty.isEmpty
        else { return nil }
        let allowed = (options["allowCredentials"] as? [[String: Any]] ?? [])
            .compactMap { ($0["id"] as? String).flatMap(Data.init(base64Url:)) }
        return PasskeyChallenge(
            challenge: challenge,
            relyingParty: relyingParty,
            allowCredentials: allowed,
            userVerification: options["userVerification"] as? String,
            cookie: cookie
        )
    }

    /// The cookies the options response set, as a `Cookie` header for the answer.
    ///
    /// Better Auth keeps the challenge on the server and names it in a signed cookie, so a
    /// verification that arrives without it is refused as "challenge not found" however
    /// good the signature. The site's page gets this for nothing from the browser; this
    /// client keeps no cookie jar, on purpose (`UnbentApi.configuration`), so the one
    /// request that needs a cookie from the one before carries it by hand.
    static func challengeCookie(_ response: HTTPURLResponse) -> String? {
        let pairs = SessionCookie.setCookieLines(response).compactMap { line -> String? in
            let parts = line.split(separator: ";", omittingEmptySubsequences: false)
            let attributes = parts.dropFirst().map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            guard let pair = parts.first?.trimmingCharacters(in: .whitespaces), pair.contains("="),
                  !attributes.contains("max-age=0") else { return nil }
            return pair
        }
        return pairs.isEmpty ? nil : pairs.joined(separator: "; ")
    }
}
