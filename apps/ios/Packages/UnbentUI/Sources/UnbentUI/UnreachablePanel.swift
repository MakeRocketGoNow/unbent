import SwiftUI

/// What shows when the site cannot be reached, in place of a blank web view — WebKit has no
/// error page of its own, and an empty screen offers nothing to do.
///
/// Covers the whole shell, strips and all, on the ground the page would have had.
public struct UnreachablePanel: View {
    private let canChangeAddress: Bool
    private let onRetry: () -> Void
    private let onSettings: () -> Void

    /// - Parameter canChangeAddress: whether App settings has an address to check. A
    ///   release build is fixed to one instance, and telling someone to check an address
    ///   they cannot change sends them looking for a field that is not there.
    public init(canChangeAddress: Bool, onRetry: @escaping () -> Void, onSettings: @escaping () -> Void) {
        self.canChangeAddress = canChangeAddress
        self.onRetry = onRetry
        self.onSettings = onSettings
    }

    public var body: some View {
        VStack(spacing: 0) {
            Text("Couldn’t reach Unbent")
                .font(.title3.weight(.semibold))
            Text(canChangeAddress
                ? "Check your connection, or the address in App settings."
                : "Check your connection, then try again.")
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.top, Space.small)
                .padding(.bottom, Space.screen)
            HStack(spacing: Space.small) {
                Button("App settings", action: onSettings)
                    .buttonStyle(.unbent(.quiet, compact: true))
                Button("Try again", action: onRetry)
                    .buttonStyle(.unbent(.primary, compact: true))
            }
        }
        .multilineTextAlignment(.center)
        .padding(Space.screen)
        .frame(maxWidth: Metrics.column)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.unbentGround)
        .tint(.unbentAccent)
    }
}

#Preview {
    UnreachablePanel(canChangeAddress: true, onRetry: {}, onSettings: {})
}
