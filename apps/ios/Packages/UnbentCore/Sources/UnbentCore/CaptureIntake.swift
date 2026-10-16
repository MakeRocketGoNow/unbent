import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What was shared, once it has been copied somewhere this app controls.
public struct CaptureIntake: Equatable, Sendable {
    public var files: [CaptureJob.File] = []
    /// Shared text, and any link that came with it, for the note's body.
    public var text = ""
    /// What the sending app called it, when it said: a page's title beside its link.
    public var subject: String?

    public init() {}

    public var isEmpty: Bool { files.isEmpty && text.isEmpty }

    public var title: String {
        CaptureNaming.deriveTitle(subject: subject, filenames: files.map(\.name), text: text)
    }

    public var summary: String {
        CaptureNaming.summary(
            contentTypes: files.map(\.contentType),
            hasText: !text.isEmpty,
            link: text.range(of: #"^https?://\S+$"#, options: .regularExpression) != nil
        )
    }
}

/// Copies shared content out of the sending app and into a capture's directory.
///
/// This has to finish before the share sheet closes. What a share hands over is a
/// temporary copy that exists for the length of one callback, or a file in another app's
/// container this process may read only while it holds the grant; the upload happens
/// later and in another process, which has neither.
///
/// One file at a time and never through memory: an extension is allowed about 120 MB,
/// and a video is larger than that. A file is copied by the file system; a photo that has
/// to be transcoded is the one thing decoded, and that is bounded (`toJpeg`).
///
/// Not for two callers at once: it counts and names as it goes, and `stage(_:contentText:)`
/// takes a share's items in turn.
///
/// The Android app's half is `Staging.stageAll` and `Heif.kt`.
public final class CaptureStager: @unchecked Sendable {
    private let directory: URL
    private var used = Set<String>()
    private var index = 0

    /// - Parameter directory: the capture's own, from `CaptureStore.create`.
    public init(directory: URL) {
        self.directory = directory
    }

    // MARK: - Files

    /// Stages the file at `source` under a name the API accepts, or returns nil when it
    /// could not be read. One unreadable file does not lose the rest of the share.
    ///
    /// - Parameters:
    ///   - type: what the file is, when the sender said; otherwise read from its name.
    public func stage(fileAt source: URL, type: UTType? = nil, suggestedName: String? = nil) -> CaptureJob.File? {
        let type = type ?? UTType(filenameExtension: source.pathExtension) ?? .data
        let given: String? = Self.name(suggested: suggestedName, source: source, type: type)
        defer { index += 1 }

        if Self.isHeif(type) {
            // HEIC is what a phone camera hands over, and nothing but Safari shows it: the
            // server serves inline only an allowlist of image types, and HEIC is not on it.
            // So it becomes a JPEG here, on the one device that can certainly decode it.
            let name = CaptureNaming.uniquify(CaptureNaming.jpegName(given, index: index), used: &used)
            if Self.toJpeg(source, directory.appendingPathComponent(name)) {
                return CaptureJob.File(name: name, contentType: "image/jpeg")
            }
            // Not decodable after all: sent as it is, which stores it, rather than lost.
            used.remove(name.lowercased())
        }

        let name = CaptureNaming.uniquify(
            CaptureNaming.sanitize(given, index: index, fallbackExtension: type.preferredFilenameExtension ?? "bin"),
            used: &used
        )
        do {
            try FileManager.default.copyItem(at: source, to: directory.appendingPathComponent(name))
        } catch {
            used.remove(name.lowercased())
            return nil
        }
        return CaptureJob.File(name: name, contentType: type.preferredMIMEType ?? "application/octet-stream")
    }

    /// A file another app opened in this one ("Open in", Files): readable only inside the
    /// grant that came with its address.
    public func stage(securityScoped source: URL) -> CaptureJob.File? {
        let granted = source.startAccessingSecurityScopedResource()
        defer { if granted { source.stopAccessingSecurityScopedResource() } }
        return stage(fileAt: source)
    }

    /// What the file is called, from the two places a name can come from.
    ///
    /// A share's own name for the file is the one the person would recognise, and it
    /// usually comes without its extension. The temporary copy has the extension and a
    /// name the system made up from the type ("PDF document.pdf") so each supplies the
    /// half the other lacks. With no suggestion the file's own name is all there is,
    /// which is right for a file opened from Files.
    static func name(suggested: String?, source: URL, type: UTType) -> String {
        guard let suggested = suggested?.trimmingCharacters(in: .whitespaces), !suggested.isEmpty else {
            return source.lastPathComponent
        }
        let ext = source.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : source.pathExtension
        if ext.isEmpty || suggested.lowercased().hasSuffix(".\(ext.lowercased())") { return suggested }
        return "\(suggested).\(ext)"
    }

    static func isHeif(_ type: UTType) -> Bool {
        type.conforms(to: .heic) || type.conforms(to: .heif)
    }

    /// The longest edge a transcoded photo keeps: a 12-megapixel photo's, which is what
    /// the camera takes by default and is left as it is. A 48-megapixel one is brought
    /// down to it, because decoding that at full size is some 190 MB of pixels and the
    /// extension would be killed halfway through. Android transcodes at full size; it
    /// has the memory to.
    static let longestEdge = 4032

    /// Writes the image at `source` to `target` as a JPEG. False when it cannot be read.
    static func toJpeg(_ source: URL, _ target: URL) -> Bool {
        guard let image = CGImageSourceCreateWithURL(source as CFURL, nil) else { return false }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: longestEdge,
            // Turned upright in the pixels: the orientation tag does not survive.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard
            let pixels = CGImageSourceCreateThumbnailAtIndex(image, 0, options as CFDictionary),
            let destination = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(destination, pixels, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        return CGImageDestinationFinalize(destination)
    }

    // MARK: - A share sheet's items

    /// Stages everything a share handed over, in order.
    ///
    /// - Parameter contentText: the text the sending app attached to the share as a
    ///   whole, which is the page's title for a link and the text itself for a selection.
    public func stage(_ providers: [NSItemProvider], contentText: String?) async -> CaptureIntake {
        var intake = CaptureIntake()
        var lines: [String] = []
        var links: [String] = []
        for provider in providers {
            switch Self.kind(of: provider) {
            case .file(let type, let load):
                if let file = await file(from: provider, type: type, load: load) { intake.files.append(file) }
            case .link:
                if let url = await Self.object(NSURL.self, from: provider) as? URL { links.append(url.absoluteString) }
            case .text:
                if let text = await Self.object(NSString.self, from: provider) as? String { lines.append(text) }
            case .nothing:
                break
            }
        }

        let attached = contentText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !links.isEmpty {
            // Beside a link the attached text is what the page is called, not content.
            if !attached.isEmpty, !links.contains(attached) { intake.subject = attached }
        } else if lines.isEmpty, intake.files.isEmpty, !attached.isEmpty {
            lines.append(attached)
        }
        intake.text = (lines + links)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
        return intake
    }

    enum Kind: Equatable {
        /// A file: what it is, and the type to ask the provider for, which differs only
        /// when a JPEG is on offer beside a HEIC.
        case file(UTType, load: UTType)
        case link
        case text
        case nothing
    }

    /// What one shared item is. A file wins over a link or text: a PDF from Files is
    /// offered as its address and as its content, and it is the content that is wanted.
    static func kind(of provider: NSItemProvider) -> Kind {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        let content = types.first {
            $0.conforms(to: .data) && !$0.conforms(to: .url) && !$0.conforms(to: .plainText)
        }
        if let content {
            // A photo is offered in several forms; the JPEG is the one that needs nothing.
            if isHeif(content), let jpeg = types.first(where: { $0.conforms(to: .jpeg) }) { return .file(jpeg, load: jpeg) }
            return .file(content, load: content)
        }
        if types.contains(where: { $0.conforms(to: .fileURL) }) { return .file(.data, load: .data) }
        if types.contains(where: { $0.conforms(to: .url) }) { return .link }
        if types.contains(where: { $0.conforms(to: .plainText) }) { return .text }
        return .nothing
    }

    private func file(from provider: NSItemProvider, type: UTType, load: UTType) async -> CaptureJob.File? {
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            // The file exists for the length of this callback, so it is staged inside it.
            _ = provider.loadFileRepresentation(forTypeIdentifier: load.identifier) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                continuation.resume(returning: self.stage(fileAt: url, type: type, suggestedName: suggested))
            }
        }
    }

    private static func object(_ kind: NSItemProviderReading.Type, from provider: NSItemProvider) async -> NSItemProviderReading? {
        guard provider.canLoadObject(ofClass: kind) else { return nil }
        return await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: kind) { object, _ in continuation.resume(returning: object) }
        }
    }
}
