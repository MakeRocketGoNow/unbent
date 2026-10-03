import SwiftUI
import UnbentCore

/// The app's own settings: which Unbent it opens, and which build it is.
///
/// Everything else a person configures lives on the site, which the app hosts whole —
/// notebooks, tags, import and export, security, deleting the account. What stays here is
/// what the site cannot know or change: the address the app points its web view at is the
/// app's, and so is its version.
///
/// A sheet over the web view rather than a page drawn in it, so the page behind is
/// untouched on the way back — its scroll, an open note, an upload in flight. A `Form`,
/// because this is the one screen in the app that is settings in the system's sense, and
/// the system's grouped list is what settings look like on this phone.
public struct AppSettingsScreen: View {
    private let instance: String
    private let allowedHosts: [String]?
    private let version: String
    private let build: String
    private let onUse: ((String) -> Void)?
    private let onReset: (() -> Void)?
    private let onDone: () -> Void

    @State private var address: String
    @State private var confirmingReset = false

    /// - Parameters:
    ///   - allowedHosts: the hosts this build's web view may open (its App-Bound Domains),
    ///     or nil when it may open any.
    ///   - onUse: points the app at another address. Nil in a release build, which is
    ///     fixed to the instance it was built for.
    ///   - onReset: throws away everything the web view keeps. Debug builds only.
    public init(
        instance: String,
        allowedHosts: [String]?,
        version: String,
        build: String,
        onUse: ((String) -> Void)?,
        onReset: (() -> Void)?,
        onDone: @escaping () -> Void
    ) {
        self.instance = instance
        self.allowedHosts = allowedHosts
        self.version = version
        self.build = build
        self.onUse = onUse
        self.onReset = onReset
        self.onDone = onDone
        _address = State(initialValue: instance)
    }

    private var normalized: String { normalizeOrigin(address) }

    /// Whether the typed address is one this build can open at all.
    private var allowed: Bool {
        guard let allowedHosts else { return true }
        guard let host = URLComponents(string: normalized)?.host?.lowercased() else { return false }
        return allowedHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    private var changed: Bool { !normalized.isEmpty && normalized != instance }

    public var body: some View {
        NavigationStack {
            Form {
                if let onUse {
                    Section {
                        TextField("Unbent address", text: $address)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .onSubmit { if changed && allowed { onUse(normalized) } }
                        // Only once there is somewhere different to go: a button that
                        // reloads the same instance would look like it did something.
                        Button("Use this address") { onUse(normalized) }
                            .disabled(!changed || !allowed)
                    } header: {
                        Text("Unbent address")
                    } footer: {
                        Text(addressHint)
                    }
                } else {
                    Section {
                        Text(instance.replacingOccurrences(of: "https://", with: ""))
                            .textSelection(.enabled)
                    } header: {
                        Text("Unbent address")
                    } footer: {
                        Text("This app opens this Unbent and no other. To use one you host yourself, build the app for its address; the project’s README says how.")
                    }
                }

                if let onReset {
                    Section {
                        if confirmingReset {
                            // In the row the button was in, not an alert over the screen:
                            // what is being decided about is right here, and the question
                            // appears where the tap was.
                            Text("Remove everything the web view keeps on this device, for every address? That is the site’s offline copy of your notes and any edits still waiting to sync. You stay signed in.")
                                .font(.subheadline)
                            Button("Keep it") { confirmingReset = false }
                            Button("Reset web data", role: .destructive) {
                                confirmingReset = false
                                onReset()
                            }
                        } else {
                            Button("Reset web data…", role: .destructive) { confirmingReset = true }
                        }
                    } header: {
                        Text("Debug")
                    }
                }

                Section {
                    // Both numbers, because neither identifies a build alone: the version
                    // repeats across every build between bumps, and the build number is
                    // the one that rises each time. Together they match what TestFlight
                    // lists, so a tester can say which build they are on.
                    LabeledContent("Version", value: "\(version) (\(build))")
                }
            }
            .navigationTitle("App settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                }
            }
        }
        .tint(.unbentAccent)
    }

    private var addressHint: String {
        let switching = "The Unbent this app opens. Switching signs you in there; you stay signed in here for when you switch back."
        guard let allowedHosts, !allowedHosts.isEmpty else { return switching }
        let hosts = ListFormatter.localizedString(byJoining: allowedHosts)
        if changed && !allowed { return "This build can only open \(hosts)." }
        return "\(switching) This build can open \(hosts)."
    }
}

#Preview("Debug") {
    AppSettingsScreen(
        instance: "http://localhost:5204",
        allowedHosts: ["unbent.app", "localhost"],
        version: "0.2.0",
        build: "1",
        onUse: { _ in },
        onReset: {},
        onDone: {}
    )
}

#Preview("Release") {
    AppSettingsScreen(
        instance: "https://unbent.app",
        allowedHosts: ["unbent.app"],
        version: "0.2.0",
        build: "42",
        onUse: nil,
        onReset: nil,
        onDone: {}
    )
}
