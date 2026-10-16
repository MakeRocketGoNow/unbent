import Foundation

/// Files the page writes onto the phone, a piece at a time.
///
/// The site builds an export's zip itself (apps/web/src/export-archive.ts). In a browser it
/// writes to a file the person picked or hands over a `blob:` download at the end; a web
/// view has no picker, and a `blob:` address is readable only by the page that made it. So
/// the page streams the bytes here through the bridge, and they go to storage as they come:
/// a library far larger than the web view could hold in memory exports the same as a
/// notebook.
///
/// Android's bridge calls are synchronous, which is its backpressure. A WKWebView has no
/// synchronous call from a page, so each call here is answered with a promise instead
/// (MAK-150), and the rule that keeps it safe is the caller's: answer `chunk` only once this
/// has returned, which is once the bytes are written. The app runs every call on one
/// serial queue, `abortAll` included: a file must not be closed from another thread while
/// a write to it is under way. The lock guards the table of open saves and nothing more;
/// it does not make the files themselves safe to share.
///
/// A save that ends without `end` (the export stopped or failed, or the page went away)
/// is removed, never left half-written where it would look like a backup.
///
/// A port of `SaveStreams.kt`, test for test.
public final class SaveStreams {

    /// Where one save's bytes go, and how it is kept or thrown away at the end.
    public struct Target {
        public let write: (Data) throws -> Void
        public let close: () throws -> Void
        public let keep: () throws -> Void
        public let discard: () -> Void

        public init(
            write: @escaping (Data) throws -> Void,
            close: @escaping () throws -> Void,
            keep: @escaping () throws -> Void,
            discard: @escaping () -> Void
        ) {
            self.write = write
            self.close = close
            self.keep = keep
            self.discard = discard
        }
    }

    private let create: (_ name: String, _ type: String) throws -> Target?
    private var open: [String: Target] = [:]
    private let lock = NSLock()

    public init(create: @escaping (_ name: String, _ type: String) throws -> Target?) {
        self.create = create
    }

    /// Starts a save. The id to write to, or empty when nothing could be created.
    public func begin(name: String, type: String) -> String {
        guard let target = try? create(Self.safeName(name), type) else { return "" }
        let id = UUID().uuidString
        lock.withLock { open[id] = target }
        return id
    }

    /// Appends one piece, base64 as the bridge carries it. False when it could not be written.
    public func chunk(id: String, base64: String) -> Bool {
        guard let target = lock.withLock({ open[id] }) else { return false }
        guard let data = Data(base64Encoded: base64), (try? target.write(data)) != nil else {
            abort(id: id)
            return false
        }
        return true
    }

    /// Finishes a save and keeps the file. False when it could not be.
    public func end(id: String) -> Bool {
        guard let target = lock.withLock({ open.removeValue(forKey: id) }) else { return false }
        do {
            try target.close()
            try target.keep()
            return true
        } catch {
            target.discard()
            return false
        }
    }

    /// Throws a save away. Harmless for an id that has already ended or never began.
    public func abort(id: String) {
        guard let target = lock.withLock({ open.removeValue(forKey: id) }) else { return }
        try? target.close()
        target.discard()
    }

    /// Throws away every save still open: the page that was writing them is gone.
    public func abortAll() {
        let ids = lock.withLock { Array(open.keys) }
        ids.forEach(abort(id:))
    }

    /// The name as a file can have it: no directories, no control characters, no leading
    /// dot that would hide it, and something when nothing is left.
    public static func safeName(_ raw: String) -> String {
        var name = raw
        if let slash = name.lastIndex(of: "/") { name = String(name[name.index(after: slash)...]) }
        if let slash = name.lastIndex(of: "\\") { name = String(name[name.index(after: slash)...]) }
        name = String(String.UnicodeScalarView(name.unicodeScalars.filter { $0.value > 0x1f }))
        name = name.trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        name = String(name.prefix(200))
        return name.isEmpty ? "unbent-export.zip" : name
    }

    /// Saves into `folder`, telling `onKeep` where each finished file ended up.
    public static func files(in folder: SavedFiles, onKeep: @escaping (URL) -> Void) -> SaveStreams {
        SaveStreams { name, _ in
            let partial = try folder.partial()
            let handle = try FileHandle(forWritingTo: partial)
            return Target(
                write: { try handle.write(contentsOf: $0) },
                close: { try handle.close() },
                keep: { onKeep(try folder.keep(partial, as: name)) },
                discard: { try? FileManager.default.removeItem(at: partial) }
            )
        }
    }
}

/// The folder the app saves into: `Documents/Downloads`, which the Files app shows under
/// On My iPhone ▸ Unbent because the app declares its documents browsable.
///
/// Exports and attachment downloads both land here, and both are written the same way: to
/// a hidden partial file beside where it is going, renamed once whole. Android marks a
/// Downloads row pending for this; the Files app has no such flag, and a zip that appears
/// under its real name while still being written is a zip someone opens too early. A
/// partial left behind by a crash or a killed app is swept the next time the app starts.
public struct SavedFiles: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// The folder inside the app's Documents.
    public static func downloads() -> SavedFiles {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return SavedFiles(directory: documents.appendingPathComponent("Downloads", isDirectory: true))
    }

    /// An empty hidden file to write into.
    public func partial() throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = reserve()
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        return url
    }

    /// A path for a hidden file that does not exist yet, for a writer that insists on
    /// creating its own: a WKDownload refuses a destination that is already there.
    public func reserve() -> URL {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(".\(UUID().uuidString)\(Self.partialSuffix)")
    }

    /// Gives a finished partial its real name, suffixed when that name is taken.
    public func keep(_ partial: URL, as name: String) throws -> URL {
        let destination = distinct(SaveStreams.safeName(name))
        try FileManager.default.moveItem(at: partial, to: destination)
        return destination
    }

    /// `name` in this folder, or `name (2)`, `name (3)` … when it is taken.
    public func distinct(_ name: String) -> URL {
        var candidate = directory.appendingPathComponent(name)
        let dot = name.lastIndex(of: ".")
        let stem = dot.map { String(name[..<$0]) } ?? name
        let ext = dot.map { String(name[$0...]) } ?? ""
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent("\(stem) (\(n))\(ext)")
            n += 1
        }
        return candidate
    }

    /// Removes partials nothing is writing any more. Call once at launch, before any save.
    public func sweep() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix(".") && name.hasSuffix(Self.partialSuffix) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    private static let partialSuffix = ".partial"
}
