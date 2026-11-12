import Foundation
import UserNotifications

/// The one notification a capture has, from Save to the note it became.
///
/// The share sheet is gone before the upload has started, so a capture's status lives in
/// Notification Center: "Saving…" as the sheet closes, replaced in place (one identifier
/// per capture) by "Saved" naming the note, which opens it when tapped. The extension
/// posts the first and the app the rest; because they share the identifier, neither needs
/// to know what the other did.
///
/// Asked for provisionally (`request`), which shows no prompt: the notifications arrive
/// quietly in Notification Center with the system's own Keep or Turn Off under the first.
/// A prompt on first launch, before anything has been shared, would be asking for
/// something nobody has yet seen the use of.
///
/// The Android app's half is `CaptureNotifications.kt`.
public struct CaptureNotifications: CaptureNotifying {
    public init() {}

    /// Asks for quiet delivery. Harmless to repeat: once the person has decided either
    /// way, the system answers from that and shows nothing.
    public static func request() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .provisional]) { _, _ in }
    }

    public func saving(_ job: CaptureJob) { post(job, "Saving…") }

    /// Replaces "Saving…" while a capture waits for the server to come back, which can
    /// be hours.
    public func waiting(_ job: CaptureJob) { post(job, "Waiting for Unbent to come back") }

    /// "Page clipped" for a note that is the shared page itself, read on the server,
    /// against "Saved" for a note holding its link: the one word that says which of the
    /// two landed. A link whose page could not be read fell back to the plain note and
    /// says "Saved", honestly (`CaptureJob.Clip`). A clip has no files of its own to be
    /// left out, so the count below is the plain capture's alone.
    public func saved(_ job: CaptureJob) {
        let missing = job.filesNotAdded
        let title = switch missing {
        case 0: job.clip == nil ? "Saved" : "Page clipped"
        case 1: "Saved, but 1 file could not be added"
        default: "Saved, but \(missing) files could not be added"
        }
        post(job, title, noteId: job.noteId)
    }

    public func failed(_ job: CaptureJob) { post(job, "Could not save") }

    /// The capture is kept, so there is nothing to share again: signing in finishes it.
    public func signInNeeded(_ job: CaptureJob) { post(job, "Sign in to Unbent to finish saving") }

    /// The plan would not take the capture, and it is kept (`CaptureRefusal`).
    ///
    /// The title names the room there is none of, short enough for a notification's first
    /// line. The first is the web app's own word for the state (its banner says "Your
    /// notes are read-only"), and on purpose not "Your plan has ended": a renewal that
    /// failed is answered with the same code, and that account's plan has not ended, its
    /// card has to be updated. A tap opens the Plan page, which has the numbers for every one of these and
    /// says what to delete. Inside the app that page draws no Subscribe or storage
    /// buttons (the stores' billing rules; `isHosted` in the web app's `Plan.tsx`) and
    /// says to do those on the web, so the notice promises a reason, not a checkout. The second
    /// line says the one thing the person cannot see for themselves, which is that what
    /// they shared has not been lost and needs no sharing again. The words are the
    /// Android app's (`refused_*` in its `strings.xml`).
    ///
    /// `again` for a capture that was refused before and has been again, which happens
    /// each time the app is opened while the plan stays as it is. The first notice may
    /// drop down over the app; a repeat is passive, which `quiet(_:)` reads to keep it to
    /// Notification Center. Without that, the same notice came down over the page
    /// on every return to the app. Android's repeat is silent for the same reason.
    public func refused(_ job: CaptureJob, _ refusal: CaptureRefusal, again: Bool) {
        let title = switch refusal {
        case .planEnded: "Your notes are read-only"
        case .freeNotesFull: "The free plan is full"
        case .storageFull: "Out of storage"
        case .notesFull: "Out of room for notes"
        case .plan: "Your plan has no room for this"
        }
        post(job, title, detail: "Not saved yet. It is kept on this device and tried again after you open Unbent.", plan: true, quiet: again)
    }

    /// Whether a notification is one to list without showing over the app: a repeat of a
    /// refusal the person has already been told about.
    public static func quiet(_ content: UNNotificationContent) -> Bool {
        content.interruptionLevel == .passive
    }

    /// The page a tapped notification is for, as a path on the site: the note "Saved"
    /// names, or the Plan page for a capture the plan refused. Nil for one that names
    /// neither. Built here from what the notification carries, never carried as a path,
    /// so nothing in a notification's payload chooses where the app goes.
    public static func path(in userInfo: [AnyHashable: Any]) -> String? {
        if let id = userInfo[noteKey] as? String, UUID(uuidString: id) != nil { return "/notes/\(id)" }
        if userInfo[planKey] as? Bool == true { return "/settings/plan" }
        return nil
    }

    private static let noteKey = "noteId"
    private static let planKey = "plan"

    /// The note's title is the second line throughout, so "Saved" says what was saved.
    private func post(_ job: CaptureJob, _ title: String, noteId: String? = nil, detail: String? = nil, plan: Bool = false, quiet: Bool = false) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = [job.title.isEmpty ? "Untitled" : job.title, detail].compactMap { $0 }.joined(separator: "\n")
        if let noteId { content.userInfo = [Self.noteKey: noteId] }
        if plan { content.userInfo = [Self.planKey: true] }
        if quiet { content.interruptionLevel = .passive }
        // Notifications may be off; the capture itself is unaffected.
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: job.id, content: content, trigger: nil))
    }
}
