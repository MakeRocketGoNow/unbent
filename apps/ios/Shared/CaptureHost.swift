import Observation
import SwiftUI
import UnbentCore
import UnbentUI

/// What a capture sheet is waiting on: the copy of what was shared, which finishes a
/// moment after the sheet is up.
@MainActor
@Observable
final class CaptureModel {
    /// Nil until the files have been copied, which is what keeps Save disabled.
    var intake: CaptureIntake?
    /// Why there is nothing to save, when there is not.
    var problem: String?

    /// Records the copy, or that it came to nothing.
    func staged(_ intake: CaptureIntake) {
        if intake.isEmpty {
            problem = "There is nothing here that Unbent can save."
        } else {
            self.intake = intake
        }
    }

    static let noRoom = "Unbent could not keep what you shared on this phone."
}

/// `CaptureSheet`, fed from the model and from whoever is signed in. The same in the
/// share extension and in the app, for a file opened in it.
struct CaptureHost: View {
    let model: CaptureModel
    let origin: String
    let session: SessionCookie?
    let lastNotebook: String?
    let onSave: (_ title: String, _ notebook: String?, _ tags: [String]) -> Void
    let onCancel: () -> Void

    var body: some View {
        CaptureSheet(
            summary: model.intake?.summary,
            suggestedTitle: model.intake?.title ?? "",
            problem: model.problem,
            signedIn: session != nil,
            lastNotebook: lastNotebook,
            load: { [origin, session] in await Self.choices(origin: origin, bearer: session?.bearer) },
            onSave: onSave,
            onCancel: onCancel
        )
    }

    /// The account's notebooks and tags. Either failing leaves its list empty and the
    /// form usable: the Inbox is always there, and a tag can be typed.
    private static func choices(origin: String, bearer: String?) async -> CaptureSheet.Choices {
        let api = UnbentApi(origin: origin, bearer: bearer)
        async let notebooks = try? api.listNotebooks().notebooks
        async let tags = try? api.listTags()
        return await CaptureSheet.Choices(notebooks: notebooks ?? [], tags: tags ?? [])
    }
}

extension CaptureJob {
    /// The capture a sheet's Save makes, out of what was staged and what was chosen.
    init(id: String, origin: String, intake: CaptureIntake, title: String, notebook: String?, tags: [String]) {
        self.init(
            id: id,
            origin: origin,
            // A title cleared by hand gets the derived one back: an untitled note is the
            // one thing this sheet exists to prevent.
            title: title.isEmpty ? intake.title : title,
            body: intake.text,
            notebook: notebook,
            tags: tags,
            files: intake.files
        )
    }
}
