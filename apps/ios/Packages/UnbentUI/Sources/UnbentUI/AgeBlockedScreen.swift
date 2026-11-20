import SwiftUI
import UnbentCore

/// What someone the system has said is under `minimumAge` sees instead of the app, every
/// time they open it, until the system says otherwise. The Android app's
/// `AgeBlockedActivity`, in the same words where the platforms allow.
///
/// No way in from here: no sign-in, no App settings, nothing that reaches an account. Two
/// actions. "Check again" asks the system again, for the adult whose Apple Account had the
/// wrong age (or a parent's phone) and has since corrected it. "How to delete my account"
/// opens the instance's own deletion page, the existing flow rather than a second one: the
/// block already took the app's session, and an account is deleted by its owner confirming
/// it, never because the system's answer said so.
public struct AgeBlockedScreen: View {
    private let checking: Bool
    private let lastVerdict: AgeVerdict?
    private let onCheck: () -> Void
    private let onDelete: () -> Void

    /// - Parameters:
    ///   - checking: a check is under way; the button shows a spinner and takes no press.
    ///   - lastVerdict: what the last press heard, nil before one. A minor's answer and no
    ///     answer are said apart: telling someone on a train that the system still
    ///     disagrees sends them to correct an age that may already be right.
    public init(checking: Bool, lastVerdict: AgeVerdict?, onCheck: @escaping () -> Void, onDelete: @escaping () -> Void) {
        self.checking = checking
        self.lastVerdict = lastVerdict
        self.onCheck = onCheck
        self.onDelete = onDelete
    }

    public var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Text("Unbent is for adults")
                        .font(.title3.weight(.semibold))
                    Text("Your Apple Account says the person using this iPhone is under \(minimumAge). You need to be \(minimumAge) or older to use Unbent.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.top, Space.small)
                    Text(hint)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.top, Space.small)
                        .padding(.bottom, Space.screen)
                    // The same pair as the unreachable panel, the way out quiet and the
                    // retry filled, side by side while they fit. At the larger text sizes
                    // "How to delete my account" does not fit beside its neighbour, and a
                    // label cut short is the one thing on this screen it cannot afford, so
                    // they stack, the retry first.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Space.small) {
                            delete
                            check
                        }
                        VStack(spacing: Space.small) {
                            check
                            delete
                        }
                    }
                }
                .multilineTextAlignment(.center)
                .padding(Space.screen)
                .frame(maxWidth: Metrics.column)
                // Centred in whatever height there is, and scrolling once there is not
                // enough of it: the larger text sizes on a small phone, where the two
                // buttons are what would otherwise be pushed off the bottom.
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color.unbentGround)
        .tint(.unbentAccent)
    }

    private var delete: some View {
        Button("How to delete my account", action: onDelete)
            .buttonStyle(.unbent(.quiet, compact: true))
    }

    private var check: some View {
        Button(action: onCheck) {
            // A few calls to the system in a row can take seconds, and a faded button alone
            // reads as broken. The label stays, unseen, so the button keeps its width and
            // the quiet action beside it does not move.
            ZStack {
                Text("Check again").opacity(checking ? 0 : 1)
                if checking {
                    ProgressView()
                        .tint(.unbentOnAccent)
                        .accessibilityLabel("Checking")
                }
            }
        }
        .buttonStyle(.unbent(.primary, compact: true))
        .disabled(checking)
    }

    private var hint: String {
        switch lastVerdict {
        case .minor:
            "Your Apple Account still doesn’t show you as \(minimumAge) or older."
        case .unknown:
            "Your iPhone didn’t share an age range this time. Check your connection and your age range sharing in Settings, then try again."
        case .adult, nil:
            "If that’s wrong, correct your age in your Apple Account, then check again."
        }
    }
}

#Preview("Blocked") {
    AgeBlockedScreen(checking: false, lastVerdict: nil, onCheck: {}, onDelete: {})
}

#Preview("No answer") {
    AgeBlockedScreen(checking: false, lastVerdict: .unknown, onCheck: {}, onDelete: {})
}

#Preview("Checking") {
    AgeBlockedScreen(checking: true, lastVerdict: nil, onCheck: {}, onDelete: {})
}
