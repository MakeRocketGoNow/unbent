import Observation
import SwiftUI
import UnbentCore
import UnbentUI

/// What the blocked screen shows that changes: whether a check is under way, and what the
/// last one heard. The screen itself (`AgeBlockedScreen`) takes plain values, like every
/// view in `UnbentUI`; `RootViewController.blocked` fills in the two actions.
@MainActor
@Observable
final class AgeBlockedModel {
    var checking = false
    var lastVerdict: AgeVerdict?
    var onCheck: () -> Void = {}
    var onDelete: () -> Void = {}
}

/// `AgeBlockedScreen`, fed from the model.
struct AgeBlockedHost: View {
    let model: AgeBlockedModel

    var body: some View {
        AgeBlockedScreen(
            checking: model.checking,
            lastVerdict: model.lastVerdict,
            onCheck: model.onCheck,
            onDelete: model.onDelete
        )
    }
}
