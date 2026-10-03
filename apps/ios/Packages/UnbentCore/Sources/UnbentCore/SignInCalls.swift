import Foundation

/*
 * The two ways in that are nothing but requests: a password, and a code by email. Both go
 * to Better Auth's own endpoints, and both end the way every sign-in here ends — with the
 * session cookie the response set, read by `SessionCookie.fromSetCookie`.
 *
 * The Android app's halves are `PasswordAuth.kt` and `EmailOtpAuth.kt`.
 */

/// Email and password.
///
/// Offered only when the instance says so (`AppConfig.password`): it exists for self-hosted
/// instances, which cannot register OAuth callbacks with Google or Apple on anyone's
/// behalf, and unbent.app leaves it off. Nothing is stored here but the resulting session;
/// the password goes to the server once and is forgotten.
public struct PasswordAuth: Sendable {
    private let origin: String
    private let session: URLSession

    public init(origin: String, session: URLSession = UnbentApi.shared) {
        self.origin = origin
        self.session = session
    }

    public func signIn(email: String, password: String) async throws -> SessionCookie {
        try await signInCall(
            origin, "/api/auth/sign-in/email", ["email": email, "password": password], "Sign-in", session
        )
    }

    /// Creates an account. The instance's allowlist decides, and its refusal is the message.
    public func signUp(email: String, password: String, name: String) async throws -> SessionCookie {
        try await signInCall(
            origin, "/api/auth/sign-up/email", ["email": email, "password": password, "name": name], "Sign-up", session
        )
    }
}

/// A six-digit code by email.
///
/// The way in that needs no account anywhere else, and on a phone the reason it is a code
/// rather than a link: a link tapped in a mail app opens in whichever browser that app
/// prefers, which is not this app and often not even the browser holding a session, so the
/// sign-in lands somewhere the person cannot see. A code is typed back into the screen that
/// asked for it.
///
/// Sign-up and sign-in are one flow — an address with no account gets one — so there is no
/// separate registration call here. The instance's allowlist still decides, and `signIn`
/// surfaces its refusal through `ApiError.serverMessage`.
public struct EmailOtpAuth: Sendable {
    private let origin: String
    private let session: URLSession

    public init(origin: String, session: URLSession = UnbentApi.shared) {
        self.origin = origin
        self.session = session
    }

    /// Asks for a code. Succeeds whether or not the address has an account, which is
    /// deliberate upstream: answering differently would make this a way to ask whether a
    /// given person uses this instance.
    public func sendCode(email: String) async throws {
        let request = try post(origin, "/api/auth/email-otp/send-verification-otp", ["email": email, "type": "sign-in"])
        let (data, response) = try await session.data(for: request)
        _ = try UnbentApi.checked(data, response, "Could not send a code")
    }

    /// Trades a code for a session. The code is single-use and burns after three tries.
    public func signIn(email: String, code: String) async throws -> SessionCookie {
        try await signInCall(origin, "/api/auth/sign-in/email-otp", ["email": email, "otp": code], "Sign-in", session)
    }
}

private func post(_ origin: String, _ path: String, _ payload: [String: String]) throws -> URLRequest {
    guard let url = URL(string: origin + path) else { throw URLError(.badURL) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    // Better Auth enforces CSRF by requiring a trusted Origin.
    request.setValue(origin, forHTTPHeaderField: "Origin")
    request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    // Sorted so the body is the same bytes every time, which a test can then compare.
    request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    return request
}

private func signInCall(
    _ origin: String,
    _ path: String,
    _ payload: [String: String],
    _ what: String,
    _ session: URLSession
) async throws -> SessionCookie {
    let (data, response) = try await session.data(for: post(origin, path, payload))
    let body = try UnbentApi.checked(data, response, what)
    guard
        let http = response as? HTTPURLResponse,
        let cookie = SessionCookie.fromSetCookie(SessionCookie.setCookieLines(http))
    else {
        throw ApiError(
            status: (response as? HTTPURLResponse)?.statusCode ?? 0,
            message: "\(what) returned no session.",
            body: String(decoding: body, as: UTF8.self)
        )
    }
    return cookie
}
