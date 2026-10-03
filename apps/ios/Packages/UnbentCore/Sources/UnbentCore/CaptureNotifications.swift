import Foundation
import UserNotifications

/// The one notification a capture has, from Save to the note it became.
///
/// The share sheet is gone before the upload has started, so a capture's status lives in
/// Notification Center: "Saving…" as the sheet closes, replaced in place — one identifier
/// per capture — by "Saved" naming the note, which opens it when tapped. The extension
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

    public func saved(_ job: CaptureJob) { post(job, "Saved", noteId: job.noteId) }

    public func failed(_ job: CaptureJob) { post(job, "Could not save") }

    /// The capture is kept, so there is nothing to share again: signing in finishes it.
    public func signInNeeded(_ job: CaptureJob) { post(job, "Sign in to Unbent to finish saving") }

    /// The note a tapped notification is for, when it is one that names a note.
    public static func noteId(in userInfo: [AnyHashable: Any]) -> String? {
        guard let id = userInfo[noteKey] as? String, UUID(uuidString: id) != nil else { return nil }
        return id
    }

    private static let noteKey = "noteId"

    /// The note's title is the second line throughout, so "Saved" says what was saved.
    private func post(_ job: CaptureJob, _ title: String, noteId: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = job.title.isEmpty ? "Untitled" : job.title
        if let noteId { content.userInfo = [Self.noteKey: noteId] }
        // Notifications may be off; the capture itself is unaffected.
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: job.id, content: content, trigger: nil))
    }
}
