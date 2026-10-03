import Foundation

/*
 * What a capture is called, and where its files wait.
 *
 * Shared content is copied into the App Group's container before the share sheet closes:
 * the files a share hands over are temporary copies that go when the extension does, and
 * the upload happens later, in another process. Everything here is the part of that with
 * no system sheet in it — names, the title, the directory — so it runs under `swift test`.
 *
 * The Android app's half is `Staging.kt`, and the rules are the same because they come
 * from the server: the API refuses path separators, `.`, `..` and leading dots, and a
 * refused name loses the file for a reason the person cannot act on.
 */

public enum CaptureNaming {
    /// Forces a name the API will accept.
    ///
    /// Names arriving from other apps are arbitrary — sometimes absent, sometimes a whole
    /// path.
    public static func sanitize(_ raw: String?, index: Int, fallbackExtension: String) -> String {
        var candidate = raw ?? ""
        if let slash = candidate.lastIndex(where: { $0 == "/" || $0 == "\\" }) {
            candidate = String(candidate[candidate.index(after: slash)...])
        }
        candidate = String(String.UnicodeScalarView(candidate.unicodeScalars.filter { $0.value > 0x1f }))
        candidate = candidate.trimmingCharacters(in: .whitespaces)
        while candidate.hasPrefix(".") { candidate.removeFirst() }

        guard !candidate.isEmpty else { return "capture-\(index + 1).\(fallbackExtension)" }
        return capLength(candidate.contains(".") ? candidate : "\(candidate).\(fallbackExtension)")
    }

    /// Bounds the whole name, extension included.
    ///
    /// The API caps a filename at 255 characters, and truncating the stem while keeping
    /// the suffix means a 400-character name from another app still arrives as something
    /// the server accepts and the person can recognise.
    static func capLength(_ name: String, max: Int = 200) -> String {
        guard name.count > max else { return name }
        let (stem, ext) = split(name)
        if ext.isEmpty || ext.count > 12 { return String(name.prefix(max)) }
        return String(stem.prefix(max - ext.count - 1)) + "." + ext
    }

    /// Distinct names within one share, so two "image.jpg" do not land on one file — in
    /// the staging directory or on the note.
    ///
    /// Compared without case: the phone's file system is case-insensitive, so `Scan.pdf`
    /// after `scan.pdf` would otherwise be the same file written twice.
    public static func uniquify(_ name: String, used: inout Set<String>) -> String {
        if used.insert(name.lowercased()).inserted { return name }
        let (stem, ext) = split(name)
        var n = 2
        while true {
            let candidate = ext.isEmpty ? "\(stem)-\(n)" : "\(stem)-\(n).\(ext)"
            if used.insert(candidate.lowercased()).inserted { return candidate }
            n += 1
        }
    }

    /// The JPEG's name for a photo that was transcoded: the original's stem, and `.jpg`.
    ///
    /// The extension is load-bearing, not cosmetic: a name still ending `.HEIC` on JPEG
    /// bytes is taken for HEIC wherever a type is read from the name, and the server
    /// does not serve HEIC inline.
    public static func jpegName(_ raw: String?, index: Int) -> String {
        split(sanitize(raw, index: index, fallbackExtension: "jpg")).stem + ".jpg"
    }

    /// The stem and the extension, split at the last dot. A name with none is all stem.
    static func split(_ name: String) -> (stem: String, ext: String) {
        guard let dot = name.lastIndex(of: ".") else { return (name, "") }
        return (String(name[..<dot]), String(name[name.index(after: dot)...]))
    }

    /// A title for the note.
    ///
    /// The subject when the sending app supplies one — a page's title, a mail's subject —
    /// otherwise the single file's own name, a link's host, the text's first line, and
    /// last the date: an untitled note is much harder to find later than one named for
    /// the afternoon it arrived.
    ///
    /// Android also credits the app a share came from ("— via Chrome"). iOS does not tell
    /// an extension who invoked it, so there is nothing to credit.
    public static func deriveTitle(
        subject: String?,
        filenames: [String],
        text: String? = nil,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> String {
        if let subject = subject?.trimmingCharacters(in: .whitespacesAndNewlines), !subject.isEmpty {
            return String(subject.prefix(200))
        }

        // A lone file: its own name, which the person chose or the camera dated.
        if filenames.count == 1 {
            let stem = split(filenames[0]).stem
            if !stem.isEmpty { return String(stem.prefix(200)) }
        }

        let body = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !body.isEmpty {
            // A shared link. The host is what someone would recognise a month later — the
            // full address is unreadable in a list, and its path is usually a slug or an id.
            if let host = hostOf(body) { return host }
            // Plain text: its first line, which is how a note would title itself anyway.
            let first = body.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            if !first.isEmpty { return String(first.prefix(200)) }
        }

        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.timeZone = timeZone
        stamp.dateFormat = "yyyy-MM-dd HH:mm"
        return "Capture \(stamp.string(from: now))"
    }

    /// The host of the first URL in some text, without the www. Nil when there is none.
    public static func hostOf(_ text: String) -> String? {
        guard
            let range = text.range(of: #"https?://\S+"#, options: .regularExpression),
            var host = URLComponents(string: String(text[range]))?.host,
            !host.isEmpty
        else { return nil }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        return host.isEmpty ? nil : host
    }

    /// "2 photos · 1 PDF", "Link" or "Text": what the sheet says was shared.
    ///
    /// - Parameter link: the text is a link and nothing else. A page shared from a
    ///   browser was reading "Text", which is not what anyone thinks they shared.
    public static func summary(contentTypes: [String], hasText: Bool, link: Bool = false) -> String {
        let photos = contentTypes.filter { $0.hasPrefix("image/") }.count
        let pdfs = contentTypes.filter { $0 == "application/pdf" }.count
        let others = contentTypes.count - photos - pdfs
        var parts: [String] = []
        if photos > 0 { parts.append(photos == 1 ? "1 photo" : "\(photos) photos") }
        if pdfs > 0 { parts.append(pdfs == 1 ? "1 PDF" : "\(pdfs) PDFs") }
        if others > 0 { parts.append(others == 1 ? "1 file" : "\(others) files") }
        if hasText && contentTypes.isEmpty { parts.append(link ? "Link" : "Text") }
        return parts.joined(separator: " · ")
    }
}

/// Where captures wait: one directory per capture, under `shares/` in the App Group's
/// container, holding its files and the record of what to do with them (`CaptureJob`).
///
/// The group's container rather than either process's own, because three things read it:
/// the extension that stages, the app that finishes the job, and the system's upload
/// daemon, which is handed files by path and reads them after both have gone.
public struct CaptureStore: Sendable {
    public let root: URL

    /// - Parameter container: the App Group's container.
    public init(container: URL) {
        root = container.appendingPathComponent("shares", isDirectory: true)
    }

    public func directory(_ jobId: String) -> URL {
        root.appendingPathComponent(jobId, isDirectory: true)
    }

    /// Makes the capture's directory, with the file protection an upload needs.
    ///
    /// Until first unlock, not the default of "while unlocked": the system uploads these
    /// with the phone locked in a pocket, and a file it cannot open then fails the upload.
    public func create(_ jobId: String) throws -> URL {
        let directory = directory(jobId)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        return directory
    }

    /// Cleanup once a capture is saved, given up on, or cancelled.
    public func clear(_ jobId: String) {
        try? FileManager.default.removeItem(at: directory(jobId))
    }

    /// The ids of the captures on disk.
    public func jobIds() -> [String] {
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return entries
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map(\.lastPathComponent)
            .sorted()
    }

    /// Deletes captures nothing has touched in three days.
    ///
    /// `clear` is the cleanup, and every way a capture ends calls it. This is for one
    /// that never got there: a sheet whose extension was killed before Save or Cancel, or
    /// a capture staged while signed out by someone who never signed in. Touched means
    /// any file in it — a capture waiting on the server rewrites its record on every
    /// attempt, so a live one never looks abandoned. Three days is well past the longest
    /// a capture waits (see `CaptureJob.maxUnavailable`).
    public func sweepAbandoned(now: Date = Date()) {
        let fm = FileManager.default
        for jobId in jobIds() {
            let directory = directory(jobId)
            let inside = (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey], options: [])) ?? []
            let touched = (inside + [directory])
                .compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
                .max() ?? .distantPast
            if now.timeIntervalSince(touched) > Self.abandoned { try? fm.removeItem(at: directory) }
        }
    }

    static let abandoned: TimeInterval = 3 * 24 * 60 * 60
}
