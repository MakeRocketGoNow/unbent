import DeclaredAgeRange
import UIKit
import UnbentCore

/// Apple's Declared Age Range framework, as the two questions `AgeGate` asks.
///
/// The framework is iOS 26, and its question of whether a law applies is 26.2, against a
/// deployment target of 17: `AgeGate.system(over:)` gives an older system no source at
/// all, which the gate reads as unknown and lets the person in. Nothing earlier than 26.2
/// is asked even though the range request is 26.0, because without the eligibility
/// question the only way to learn whether a law applies is to ask everyone, and that is
/// the prompt in front of every adult this is built to avoid.
///
/// The framework's answer is reduced to two bounds here and goes no further: what kind of
/// check produced it and which parental controls are on are never read.
///
/// Needs the `com.apple.developer.declared-age-range` entitlement, without which the
/// framework answers nothing. Only a device on 26.2 with a sandbox account can exercise it
/// (Settings, Developer, Sandbox Testing, Age Assurance); the simulator cannot.
@available(iOS 26.2, *)
struct DeclaredAgeRanges: AgeRangeAsking, @unchecked Sendable {
    /// What the system draws its sheet over, when it has one to draw. Weak, so a check
    /// still under way does not keep a screen the app has moved on from. Read only on the
    /// main actor, which is what makes the unchecked `Sendable` true.
    private weak var presenter: UIViewController?

    init(presenter: UIViewController) {
        self.presenter = presenter
    }

    func isEligible() async throws -> Bool {
        try await AgeRangeService.shared.isEligibleForAgeFeatures
    }

    @MainActor
    func requestRange(gate: Int) async throws -> AgeRangeAnswer {
        guard let presenter, presenter.view.window != nil else { throw AgeRangeService.Error.notAvailable }
        switch try await AgeRangeService.shared.requestAgeRange(ageGates: gate, in: presenter) {
        case .declinedSharing:
            return .declined
        case let .sharing(range):
            return .sharing(lower: range.lowerBound, upper: range.upperBound)
        @unknown default:
            return .declined
        }
    }
}

extension AgeGate {
    /// The gate over the system's own answer, drawing any prompt over `presenter`.
    @MainActor
    static func system(over presenter: UIViewController) -> AgeGate {
        if #available(iOS 26.2, *) {
            return AgeGate(source: DeclaredAgeRanges(presenter: presenter))
        }
        return AgeGate(source: nil)
    }
}
