import AuthenticationServices
import UIKit
import UnbentCore

/// The system's own sign-in sheets — a browser, Apple's, the passkey one — each as a call
/// that returns what the sheet gave back.
///
/// The requests either side of them are `UnbentCore`'s (`NativeSignIn.swift`); this is the
/// part that needs a window to stand on, and nothing else. One sheet at a time: the screen
/// behind them disables its buttons while any way in is under way.
@MainActor
final class SignInSheets: NSObject {
    private let anchor: () -> ASPresentationAnchor?

    /// Both are held for as long as their sheet is up: the system keeps neither, and one
    /// that is let go takes its sheet down with it, with no error to say why.
    private var browser: ASWebAuthenticationSession?
    private var controller: ASAuthorizationController?
    private var waiting: CheckedContinuation<ASAuthorization, Error>?

    /// - Parameter anchor: the window the sheets stand on.
    init(anchor: @escaping () -> ASPresentationAnchor?) {
        self.anchor = anchor
    }

    /// Opens `url` in the system's sign-in browser and returns the address it came back on.
    ///
    /// Not ephemeral, deliberately: the browser shares Safari's cookies, so someone
    /// already signed in to Google there — or to this very site — is a tap from done
    /// instead of typing a password into a sheet. The price is the system's "wants to use
    /// … to sign in" prompt, which an ephemeral session skips.
    func browse(_ url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                Task { @MainActor in
                    self?.browser = nil
                    if let callback {
                        continuation.resume(returning: callback)
                    } else {
                        continuation.resume(throwing: error ?? ASWebAuthenticationSessionError(.canceledLogin))
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            browser = session
            if !session.start() {
                browser = nil
                continuation.resume(throwing: ASWebAuthenticationSessionError(.presentationContextInvalid))
            }
        }
    }

    /// Apple's sheet: the identity token, and the name on the one occasion Apple gives it.
    func apple(nonce: AppleAuth.Nonce) async throws -> (identityToken: String, name: String?) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        // The hash, never the nonce: see `AppleAuth.Nonce`.
        request.nonce = nonce.hashed
        let authorization = try await perform(request)
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let token = credential.identityToken.flatMap({ String(data: $0, encoding: .utf8) })
        else {
            throw ApiError(status: 0, message: "Apple’s sheet returned no identity token.")
        }
        let name = AppleAuth.displayName(given: credential.fullName?.givenName, family: credential.fullName?.familyName)
        return (token, name)
    }

    /// The passkey sheet, asked for a signature over the server's challenge.
    func passkey(_ challenge: PasskeyChallenge) async throws -> PasskeyAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: challenge.relyingParty)
        let request = provider.createCredentialAssertionRequest(challenge: challenge.challenge)
        request.allowedCredentials = challenge.allowCredentials.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        // The server's word, as it wrote it: the type is the same three strings.
        if let verification = challenge.userVerification {
            request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreference(rawValue: verification)
        }
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw ApiError(status: 0, message: "The passkey sheet returned something that is not a passkey.")
        }
        return PasskeyAssertion(
            credentialID: credential.credentialID,
            clientDataJSON: credential.rawClientDataJSON,
            authenticatorData: credential.rawAuthenticatorData,
            signature: credential.signature,
            userHandle: credential.userID
        )
    }

    /// True when the person closed the sheet, or had nothing to offer it.
    ///
    /// Both are ordinary and neither is worth an error: someone who taps the passkey
    /// button without a passkey on this phone should find the other methods still sitting
    /// there, not a failure.
    static func wasCancelled(_ error: Error) -> Bool {
        if let error = error as? ASWebAuthenticationSessionError { return error.code == .canceledLogin }
        if let error = error as? ASAuthorizationError { return error.code == .canceled }
        return false
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            waiting = continuation
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        controller = nil
        waiting?.resume(with: result)
        waiting = nil
    }
}

extension SignInSheets: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        finish(.success(authorization))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finish(.failure(error))
    }
}

extension SignInSheets: ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor() ?? ASPresentationAnchor()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor() ?? ASPresentationAnchor()
    }
}
