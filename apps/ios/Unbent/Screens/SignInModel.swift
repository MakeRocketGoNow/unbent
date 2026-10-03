import Observation
import os
import SwiftUI
import UnbentCore
import UnbentUI

/// Signs this phone in to an Unbent account, by the methods this build has.
///
/// This phase has the two that are nothing but requests: a code by email, and a password.
/// Apple, Google, another provider through the browser, and passkeys arrive with MAK-155.
/// Whichever it is ends the same way — the session cookie the response set, handed to
/// `onSignedIn` — which is the whole reason they can be added one at a time.
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

    private let onSignedIn: (SessionCookie) -> Bool
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "unbent", category: "sign-in")

    /// - Parameter onSignedIn: keeps the session and moves on; false when it could not be
    ///   kept, which leaves this screen up to say so.
    init(origin: String, onSignedIn: @escaping (SessionCookie) -> Bool) {
        self.origin = origin
        self.onSignedIn = onSignedIn
    }

    private var host: String { origin.replacingOccurrences(of: "https://", with: "") }

    /// Asks the instance which methods to draw. Nothing else can show until it answers.
    func loadConfig() {
        config = nil
        configError = nil
        Task {
            do {
                config = try await UnbentApi(origin: origin, bearer: nil).config()
            } catch {
                log.warning("Could not load /api/config from \(self.origin, privacy: .public): \(error.localizedDescription, privacy: .public)")
                configError = "Couldn’t get the sign-in options from \(host)."
            }
        }
    }

    /// Sends a code, or trades one for a session.
    ///
    /// One entry point for both steps because the screen drives the sequence: a nil code
    /// means "send one to this address", and a present one means "this is what arrived".
    /// Sending reports nothing on success beyond moving the screen to the code field; a
    /// confirmation nobody asked for would only be one more thing to read.
    func emailCode(email: String, code: String?) {
        run(
            // Asking for a code signs nobody in, and the line under the form should not
            // say it does.
            progress: code == nil ? "Sending a code…" : "Signing in…",
            failure: code == nil ? "Couldn’t send a code." : "That code did not work. Ask for a new one."
        ) {
            let auth = EmailOtpAuth(origin: self.origin)
            guard let code else {
                try await auth.sendCode(email: email)
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
            } catch {
                log.warning("Sign-in failed: \(error.localizedDescription, privacy: .public)")
                // The server's own words when it has some — "this instance is not open
                // for sign-ups" — since a generic message sends the person to retry a
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
            showUnavailable: BuildInfo.isDebug,
            onEmailCode: model.emailCode,
            onPassword: model.password,
            onDifferentAddress: model.differentAddress,
            onChangeInstance: onChangeInstance,
            onRetry: model.loadConfig
        )
        .task { if model.config == nil { model.loadConfig() } }
    }
}
