import Observation
import os
import SwiftUI
import UnbentCore
import UnbentUI

/// Signs this phone in to an Unbent account, by the methods this build has.
///
/// Two are nothing but requests: a code by email, and a password. Three put a sheet of the
/// system's first (`SignInSheets`): Apple's, the passkey one, and a browser at `/connect`
/// for Google and any other provider the instance has. Whichever it is ends the same way:
/// the session cookie the response set, handed to `onSignedIn`.
///
/// The Android app's half is `SignInActivity.kt`.
@MainActor
@Observable
final class SignInModel {
    let origin: String
    private(set) var config: AppConfig?
    private(set) var configError: String?
    private(set) var status: String?
    private(set) var busy = false

    /// The address a code went to, while the screen is waiting for it to be typed back.
    /// Set only once the server has taken the request: Android moves to the code step the
    /// moment the button is pressed, and a refused address then reads "we sent a code"
    /// above the reason it was not sent.
    private(set) var codeSentTo: String?

    /// The instance's Turnstile page while a code is being asked for, where the instance
    /// checks a token with that request; the screen draws it only if its widget wants a
    /// tap. See `TurnstileChallenge`.
    private(set) var challenge: TurnstileChallenge?

    private let onSignedIn: (SessionCookie) -> Bool
    private let sheets: SignInSheets
    private let connectScheme: String
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "unbent", category: "sign-in")

    /// - Parameter onSignedIn: keeps the session and moves on; false when it could not be
    ///   kept, which leaves this screen up to say so.
    init(origin: String, connectScheme: String, sheets: SignInSheets, onSignedIn: @escaping (SessionCookie) -> Bool) {
        self.origin = origin
        self.connectScheme = connectScheme
        self.sheets = sheets
        self.onSignedIn = onSignedIn
    }

    /// Asks the instance which methods to draw. Nothing else can show until it answers.
    func loadConfig() {
        config = nil
        configError = nil
        Task {
            do {
                config = try await UnbentApi(origin: origin, bearer: nil).config()
            } catch {
                log.warning("Could not load /api/config from \(self.origin, privacy: .public): \(error.localizedDescription, privacy: .public)")
                configError = "Couldn’t get the sign-in options from \(displayHost(origin))."
            }
        }
    }

    /// Sends a code, or trades one for a session.
    ///
    /// One entry point for both steps because the screen drives the sequence: a nil code
    /// means "send one to this address", and a present one means "this is what arrived".
    /// Sending reports nothing on success beyond moving the screen to the code field; a
    /// confirmation nobody asked for would only be one more thing to read.
    ///
    /// Where the instance checks a Turnstile token with the request for a code
    /// (`AppConfig.turnstile`), the token comes first, from the instance's own page in a
    /// web view nobody sees unless the widget wants a tap (`TurnstileChallenge`). A page
    /// that could not mint one ends the step with a sentence of its own: the server would
    /// only refuse a request without it, and the person is one press from trying again.
    func emailCode(email: String, code: String?) {
        let turnstile = code == nil && config?.turnstile != nil
        run(
            // Asking for a code signs nobody in, and the line under the form should not
            // say it does.
            progress: code == nil ? (turnstile ? "Checking this phone…" : "Sending a code…") : "Signing in…",
            failure: code == nil ? "Couldn’t send a code." : "That code did not work. Ask for a new one."
        ) {
            let auth = EmailOtpAuth(origin: self.origin)
            guard let code else {
                var token: String?
                if turnstile {
                    let challenge = TurnstileChallenge(origin: self.origin, bound: BuildInfo.appBoundHosts != nil)
                    self.challenge = challenge
                    defer { self.challenge = nil }
                    do {
                        token = try await challenge.token()
                    } catch {
                        self.log.warning("Turnstile gave no token: \(error.localizedDescription, privacy: .public)")
                        throw ApiError(
                            status: 0,
                            message: "The check before a code is sent did not finish. Check your connection and try again.",
                            body: ""
                        )
                    }
                    self.status = "Sending a code…"
                }
                try await auth.sendCode(email: email, captchaToken: token)
                self.codeSentTo = email
                return nil
            }
            return try await auth.signIn(email: email, code: code)
        }
    }

    /// Back to the address: the code went somewhere the person cannot read it.
    func differentAddress() {
        codeSentTo = nil
        status = nil
    }

    func password(email: String, password: String, name: String?) {
        run(progress: "Signing in…", failure: "Sign-in did not work.") {
            let auth = PasswordAuth(origin: self.origin)
            guard let name else { return try await auth.signIn(email: email, password: password) }
            // Better Auth requires a name; an account made without one is named for its
            // address, which is what the site shows until the person changes it.
            return try await auth.signUp(email: email, password: password, name: name.isEmpty ? email : name)
        }
    }

    /// Apple's sheet, then the token to the server.
    ///
    /// The name is set afterwards and its failure is let go: Apple gives it once, the
    /// account exists either way, and holding a good sign-in back over a display name
    /// would be the wrong way round.
    func apple() {
        run(progress: "Signing in…", failure: "Sign in with Apple did not work.") {
            let auth = AppleAuth(origin: self.origin)
            let nonce = AppleAuth.Nonce.random()
            let answer = try await self.sheets.apple(nonce: nonce)
            let session = try await auth.signIn(identityToken: answer.identityToken, nonce: nonce)
            if let name = answer.name {
                do {
                    try await auth.setName(name, session: session)
                } catch {
                    self.log.warning("Could not set the name Apple gave: \(error.localizedDescription, privacy: .public)")
                }
            }
            return session
        }
    }

    /// The site's own sign-in, in a browser, for Google and any provider with no sheet of
    /// its own here. It comes back with a one-time token, which is traded for a session.
    func browser() {
        run(progress: "Waiting for the browser…", failure: "Sign-in did not work.") {
            let auth = ConnectAuth(origin: self.origin)
            guard let url = auth.connectUrl(scheme: self.connectScheme) else { throw URLError(.badURL) }
            let back = try await self.sheets.browse(url, scheme: self.connectScheme)
            guard let token = ConnectAuth.token(from: back, scheme: self.connectScheme) else {
                throw ApiError(status: 0, message: "The browser came back without connecting this phone.")
            }
            self.status = "Signing in…"
            return try await auth.redeem(token: token)
        }
    }

    /// The passkey sheet, for a passkey already on this phone or in its keychain.
    ///
    /// Nothing to check first: if there is nothing to offer, the sheet says so itself and
    /// is closed, which `run` treats as nothing having happened.
    func passkey() {
        run(progress: "Signing in…", failure: "That passkey did not work.") {
            let auth = PasskeyAuth(origin: self.origin)
            let challenge = try await auth.challenge()
            let assertion = try await self.sheets.passkey(challenge)
            return try await auth.verify(assertion, for: challenge)
        }
    }

    /// Runs one step. A session ends the sign-in; nil means the step was only a step.
    private func run(progress: String, failure: String, _ step: @escaping () async throws -> SessionCookie?) {
        guard !busy else { return }
        busy = true
        status = progress
        Task {
            defer { busy = false }
            do {
                if let session = try await step() {
                    // The server signed them in and the phone could not hold on to it.
                    // Said plainly, since the alternative is a form that silently empties.
                    status = onSignedIn(session) ? "Signed in." : "Couldn’t keep the session on this device."
                } else {
                    status = nil
                }
            } catch where SignInSheets.wasCancelled(error) {
                // A sheet closed by the person. Not a failure, and nothing to say.
                status = nil
            } catch {
                log.warning("Sign-in failed: \(error.localizedDescription, privacy: .public)")
                // The server's own words when it has some ("this instance is not open
                // for sign-ups") since a generic message sends the person to retry a
                // button that will refuse them again for the same reason.
                status = (error as? ApiError)?.serverMessage() ?? failure
            }
        }
    }
}

/// `SignInScreen`, fed from the model.
struct SignInHost: View {
    let model: SignInModel
    let onChangeInstance: (() -> Void)?

    var body: some View {
        SignInScreen(
            instance: model.origin,
            config: model.config,
            configError: model.configError,
            status: model.status,
            busy: model.busy,
            codeSentTo: model.codeSentTo,
            onApple: model.apple,
            onBrowser: model.browser,
            onPasskey: model.passkey,
            onEmailCode: model.emailCode,
            onPassword: model.password,
            onDifferentAddress: model.differentAddress,
            onChangeInstance: onChangeInstance,
            onRetry: model.loadConfig,
            challenge: model.challenge.map { AnyView(ChallengeHost(challenge: $0)) }
        )
        .task { if model.config == nil { model.loadConfig() } }
    }
}
