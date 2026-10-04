import SwiftUI
import UnbentCore

/// The sign-in screen, drawn from what the instance says it offers.
///
/// The same shape as the site's login and the Android app's: a button per provider, then
/// the form for anything that starts with an email address, with a divider between the two
/// kinds. Which of those appear is the instance's decision (`/api/config`), not this
/// screen's.
///
/// The instance sits at the bottom as a line of status. Almost everyone signs in to the one
/// instance the app was built for, and an address on every sign-in screen invites the rest
/// to wonder what to type.
public struct SignInScreen: View {
    private let instance: String
    private let config: AppConfig?
    private let configError: String?
    private let status: String?
    private let busy: Bool
    private let codeSentTo: String?
    private let onApple: () -> Void
    private let onBrowser: () -> Void
    private let onPasskey: () -> Void
    private let onEmailCode: (_ email: String, _ code: String?) -> Void
    private let onPassword: (_ email: String, _ password: String, _ name: String?) -> Void
    private let onDifferentAddress: () -> Void
    private let onChangeInstance: (() -> Void)?
    private let onRetry: () -> Void

    /// - Parameters:
    ///   - codeSentTo: the address a code has been sent to, once one has. The form shows
    ///     the code step for exactly as long as this is set, so a send the server refused
    ///     — a mistyped address — leaves the person at the address, beside the reason.
    ///   - onBrowser: the site's own sign-in in a browser, for Google and for any
    ///     provider this app has no sheet for.
    ///   - onEmailCode: sends a code, then signs in with it. A nil code means "send one to
    ///     this address".
    ///   - onPassword: name is nil to sign in and present (possibly blank) to create an
    ///     account.
    ///   - onChangeInstance: nil where the build is fixed to one instance.
    public init(
        instance: String,
        config: AppConfig?,
        configError: String?,
        status: String?,
        busy: Bool,
        codeSentTo: String?,
        onApple: @escaping () -> Void,
        onBrowser: @escaping () -> Void,
        onPasskey: @escaping () -> Void,
        onEmailCode: @escaping (_ email: String, _ code: String?) -> Void,
        onPassword: @escaping (_ email: String, _ password: String, _ name: String?) -> Void,
        onDifferentAddress: @escaping () -> Void,
        onChangeInstance: (() -> Void)?,
        onRetry: @escaping () -> Void
    ) {
        self.instance = instance
        self.config = config
        self.configError = configError
        self.status = status
        self.busy = busy
        self.codeSentTo = codeSentTo
        self.onApple = onApple
        self.onBrowser = onBrowser
        self.onPasskey = onPasskey
        self.onEmailCode = onEmailCode
        self.onPassword = onPassword
        self.onDifferentAddress = onDifferentAddress
        self.onChangeInstance = onChangeInstance
        self.onRetry = onRetry
    }

    public var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Unbent")
                        .font(.largeTitle.weight(.bold))
                    Text("Sign in to see your notes and save what you share here.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.top, Space.small)
                        .padding(.bottom, Space.screen)

                    if let configError {
                        Text(configError)
                            .foregroundStyle(.red)
                            .padding(.bottom, Space.medium)
                        Button("Try again", action: onRetry)
                            .buttonStyle(.unbent(.secondary))
                    } else if let config {
                        Methods(
                            config: config,
                            busy: busy,
                            codeSentTo: codeSentTo,
                            onApple: onApple,
                            onBrowser: onBrowser,
                            onPasskey: onPasskey,
                            onEmailCode: onEmailCode,
                            onPassword: onPassword,
                            onDifferentAddress: onDifferentAddress
                        )
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: Metrics.control)
                    }

                    if let status {
                        Text(status)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, Space.screen)
                    }

                    InstanceLine(instance: instance, onChange: busy ? nil : onChangeInstance)
                        .padding(.top, Space.screen)
                }
                .padding(Space.screen)
                .frame(maxWidth: Metrics.column, alignment: .leading)
                // Centred in whatever height there is, and scrolling once there is not
                // enough of it — a small phone with the keyboard up.
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Color.unbentGround)
        .tint(.unbentAccent)
    }
}

private struct Methods: View {
    let config: AppConfig
    let busy: Bool
    let codeSentTo: String?
    let onApple: () -> Void
    let onBrowser: () -> Void
    let onPasskey: () -> Void
    let onEmailCode: (String, String?) -> Void
    let onPassword: (String, String, String?) -> Void
    let onDifferentAddress: () -> Void

    private var hasEmail: Bool { config.emailOtp || config.password }
    private var hasSheets: Bool { config.apple || config.google || config.browserSocials > 0 || config.passkey }

    var body: some View {
        // The order the site shows them in: social first, because it is one tap and needs
        // nothing typed; then the passkey, which is faster still but only for someone who
        // already has one. Outlined and equal: filling one would say the app prefers it,
        // and it does not — and Apple's rule is that its button is no quieter than the
        // others. The email form's own submit is the filled button.
        if hasSheets {
            VStack(alignment: .leading, spacing: Space.medium) {
                if config.apple {
                    Button(action: onApple) {
                        // The logo and one of the titles Apple allows beside it.
                        Label("Continue with Apple", systemImage: "apple.logo")
                    }
                }
                // Google has no sheet of its own on an iPhone without Google's SDK, which
                // is a dependency that ends in a web sheet anyway. So it is the site's
                // own Google button, in a browser — named for where it leads, since
                // "a browser" says nothing to someone looking for the word Google.
                if config.google {
                    Button("Continue with Google", action: onBrowser)
                }
                if config.browserSocials > 0 {
                    Button("Continue in a browser", action: onBrowser)
                }
                if config.passkey {
                    Button("Sign in with a passkey", action: onPasskey)
                }
            }
            .buttonStyle(.unbent(.secondary))
            .disabled(busy)
        }

        if hasSheets && hasEmail {
            OrDivider()
                .padding(.vertical, Space.large)
        }

        if hasEmail {
            EmailForm(
                otp: config.emailOtp,
                password: config.password,
                busy: busy,
                codeSentTo: codeSentTo,
                onEmailCode: onEmailCode,
                onPassword: onPassword,
                onDifferentAddress: onDifferentAddress
            )
        }

        if !hasSheets && !hasEmail {
            Text("This Unbent has no sign-in method configured.")
                .foregroundStyle(.secondary)
        }
    }
}

/// "or" between the providers and the form, so the two do not read as one list.
private struct OrDivider: View {
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        HStack(spacing: Space.medium) {
            line
            Text("or")
                .font(.footnote)
                .foregroundStyle(.secondary)
            line
        }
    }

    private var line: some View {
        Rectangle()
            .fill(Color(.separator))
            .frame(height: 1 / displayScale)
    }
}

/// Everything that starts with an email address, in one form.
///
/// The address is asked once and the ways to proceed hang off it: a password box and Sign
/// in where passwords are on, "Email me a code" where codes are on, both where both are.
/// Two forms one after the other would be two address boxes a divider apart — the same
/// question asked twice — which the site and the Android app both had and both fixed.
///
/// The password is the primary action when both exist, and the code button goes quiet
/// beside it: someone who has a password is signing in with it, and the code is for having
/// forgotten it or never set one. Two filled buttons would be a choice with no default.
private struct EmailForm: View {
    let otp: Bool
    let password: Bool
    let busy: Bool
    let codeSentTo: String?
    let onEmailCode: (String, String?) -> Void
    let onPassword: (String, String, String?) -> Void
    let onDifferentAddress: () -> Void

    private enum Field { case name, email, secret, code }

    @State private var creating = false
    @State private var email = ""
    @State private var secret = ""
    @State private var name = ""
    @State private var code = ""
    @FocusState private var focus: Field?

    private var address: String { email.trimmingCharacters(in: .whitespaces) }
    private var canSignIn: Bool { !busy && !address.isEmpty && secret.count >= 8 }
    private var canSendCode: Bool { !busy && !address.isEmpty }
    private var canSubmitCode: Bool { !busy && code.count == 6 }

    private func submitPassword() {
        onPassword(address, secret, creating ? name.trimmingCharacters(in: .whitespaces) : nil)
    }

    private func sendCode() {
        onEmailCode(address, nil)
    }

    var body: some View {
        // The code step replaces the form: there is nothing else to do until it is entered.
        Group {
            if let codeSentTo { codeStep(sentTo: codeSentTo) } else { addressStep }
        }
        .onChange(of: codeSentTo) { _, sentTo in
            // The cursor goes where the next thing is typed, in both directions.
            code = ""
            focus = sentTo == nil ? .email : .code
        }
    }

    private func codeStep(sentTo: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("We sent a code to \(sentTo). It expires in five minutes.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                // An address is as long as someone made it; the sentence wraps.
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, Space.medium)
            FieldBox(focused: focus == .code, onTap: { focus = .code }) {
                TextField("Code", text: $code)
                    .keyboardType(.numberPad)
                    // Lets the keyboard offer the code straight out of Mail or Messages.
                    .textContentType(.oneTimeCode)
                    .focused($focus, equals: .code)
                    .onChange(of: code) { _, typed in
                        // Digits only, so a code pasted with a stray space still submits.
                        let digits = String(typed.filter(\.isNumber).prefix(6))
                        if digits != typed { code = digits }
                    }
            }
            Button("Sign in") { onEmailCode(sentTo, code) }
                .buttonStyle(.unbent(.primary))
                .disabled(!canSubmitCode)
                .padding(.top, Space.large)
            // Back to the address, so a typo is fixable without starting over.
            Button("Use a different address", action: onDifferentAddress)
            .buttonStyle(.unbent(.quiet))
            .disabled(busy)
            .padding(.top, Space.hair)
        }
    }

    private var addressStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            if password && creating {
                FieldBox(focused: focus == .name, onTap: { focus = .name }) {
                    TextField("Name", text: $name)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.next)
                        .focused($focus, equals: .name)
                        .onSubmit { focus = .email }
                }
                .padding(.bottom, Space.medium)
            }

            FieldBox(focused: focus == .email, onTap: { focus = .email }) {
                TextField("Email", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(password ? .next : .go)
                    .focused($focus, equals: .email)
                    .onSubmit {
                        if password { focus = .secret } else if canSendCode { sendCode() }
                    }
            }

            if password {
                FieldBox(focused: focus == .secret, onTap: { focus = .secret }) {
                    SecureField("Password", text: $secret)
                        .textContentType(creating ? .newPassword : .password)
                        .submitLabel(.go)
                        .focused($focus, equals: .secret)
                        .onSubmit { if canSignIn { submitPassword() } }
                }
                .padding(.top, Space.medium)

                Button(creating ? "Create account" : "Sign in", action: submitPassword)
                    .buttonStyle(.unbent(.primary))
                    .disabled(!canSignIn)
                    .padding(.top, Space.large)
            }

            if otp {
                // Beside a password this is the alternative, so it is outlined rather than
                // filled; alone it is the only way forward and takes the filled treatment.
                Button("Email me a code", action: sendCode)
                    .buttonStyle(.unbent(password ? .secondary : .primary))
                    .disabled(!canSendCode)
                    .padding(.top, password ? Space.medium : Space.large)
            }

            if password {
                Button(creating ? "I already have an account" : "Create an account") { creating.toggle() }
                    .buttonStyle(.unbent(.quiet))
                    .disabled(busy)
                    .padding(.top, Space.hair)
            }
        }
    }
}

/// Which Unbent this is signing in to, and — only where the build allows another — a way
/// to change it.
private struct InstanceLine: View {
    let instance: String
    let onChange: (() -> Void)?

    var body: some View {
        HStack(spacing: Space.small) {
            // An address is as long as someone's domain. It wraps rather than pushing
            // Change off the screen.
            Text("Signing in to \(displayHost(instance))")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let onChange {
                Button("Change", action: onChange)
                    .font(.footnote.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
            }
        }
    }
}

#Preview("unbent.app") {
    SignInScreen(
        instance: "https://unbent.app",
        config: AppConfig(providers: ["google", "apple", "passkey", "email-otp"]),
        configError: nil,
        status: nil,
        busy: false,
        codeSentTo: nil,
        onApple: {},
        onBrowser: {},
        onPasskey: {},
        onEmailCode: { _, _ in },
        onPassword: { _, _, _ in },
        onDifferentAddress: {},
        onChangeInstance: {},
        onRetry: {}
    )
}

#Preview("Self-hosted") {
    SignInScreen(
        instance: "https://notes.example.com",
        config: AppConfig(providers: ["password", "email-otp"]),
        configError: nil,
        status: nil,
        busy: false,
        codeSentTo: "me@example.com",
        onApple: {},
        onBrowser: {},
        onPasskey: {},
        onEmailCode: { _, _ in },
        onPassword: { _, _, _ in },
        onDifferentAddress: {},
        onChangeInstance: nil,
        onRetry: {}
    )
}
