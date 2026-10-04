import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import UnbentCore

/// Copying what was shared into a capture's directory: files under names the API takes,
/// a HEIC as the JPEG the site can show, and text and links as the note's body.
final class CaptureIntakeTests: XCTestCase {

    private var scratch: URL!
    private var directory: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("unbent-intake-\(UUID().uuidString)")
        directory = scratch.appendingPathComponent("job")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: scratch)
    }

    private func source(_ name: String, _ contents: String = "x") throws -> URL {
        let folder = scratch.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(name)
        try Data(contents.utf8).write(to: url)
        return url
    }

    private func staged(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path)
    }

    func testAFileIsCopiedUnderItsOwnNameWithItsType() throws {
        let stager = CaptureStager(directory: directory)

        let file = try XCTUnwrap(stager.stage(fileAt: try source("Report (final) v2.pdf")))

        XCTAssertEqual("Report (final) v2.pdf", file.name)
        XCTAssertEqual("application/pdf", file.contentType)
        XCTAssertTrue(staged("Report (final) v2.pdf"))
        XCTAssertNotNil(UUID(uuidString: file.id))
    }

    func testTwoFilesOfOneNameAreBothKept() throws {
        let stager = CaptureStager(directory: directory)

        let first = try XCTUnwrap(stager.stage(fileAt: try source("scan.pdf", "one")))
        let second = try XCTUnwrap(stager.stage(fileAt: try source("scan.pdf", "two")))

        XCTAssertEqual(["scan.pdf", "scan-2.pdf"], [first.name, second.name])
        XCTAssertEqual("two", try String(contentsOf: directory.appendingPathComponent("scan-2.pdf"), encoding: .utf8))
    }

    func testAFileWithNoUsableNameIsNamedForItsPlaceAndType() throws {
        let stager = CaptureStager(directory: directory)
        _ = stager.stage(fileAt: try source("first.pdf"))

        // A provider's temporary file, named by the system with no extension.
        let file = try XCTUnwrap(stager.stage(fileAt: try source("..."), type: .png))

        XCTAssertEqual("capture-2.png", file.name)
        XCTAssertEqual("image/png", file.contentType)
    }

    func testAFileThatCannotBeReadIsLeftOutAndItsNameIsFreeAgain() throws {
        let stager = CaptureStager(directory: directory)

        XCTAssertNil(stager.stage(fileAt: scratch.appendingPathComponent("missing/scan.pdf")))

        XCTAssertEqual("scan.pdf", try XCTUnwrap(stager.stage(fileAt: try source("scan.pdf"))).name)
    }

    /// What a share actually hands over: a name with no extension, and a temporary copy
    /// the system named for its type.
    func testTheSendersNameIsKeptAndTheCopySuppliesTheExtension() {
        let copy = URL(fileURLWithPath: "/tmp/x/PDF document.pdf")
        XCTAssertEqual("Report (final) v2.pdf", CaptureStager.name(suggested: "Report (final) v2", source: copy, type: .pdf))
        XCTAssertEqual("Report.PDF", CaptureStager.name(suggested: "Report.PDF", source: copy, type: .pdf))
        // A dot in the name is not an extension.
        XCTAssertEqual("Report v2.1.pdf", CaptureStager.name(suggested: "Report v2.1", source: copy, type: .pdf))
        XCTAssertEqual("PDF document.pdf", CaptureStager.name(suggested: nil, source: copy, type: .pdf))
        XCTAssertEqual("IMG_0001.png", CaptureStager.name(suggested: "IMG_0001", source: URL(fileURLWithPath: "/tmp/x/blob"), type: .png))
    }

    func testAnUnknownTypeIsStillAFile() throws {
        let file = try XCTUnwrap(CaptureStager(directory: directory).stage(fileAt: try source("data.unbentthing")))
        XCTAssertEqual("data.unbentthing", file.name)
        XCTAssertEqual("application/octet-stream", file.contentType)
    }

    /// A real HEIC, made here: four pixels wide, so the test says nothing about memory
    /// and everything about the name and the bytes.
    func testAHeicBecomesAJpegNamedAsOne() throws {
        let heic = scratch.appendingPathComponent("IMG_0001.HEIC")
        let context = try XCTUnwrap(CGContext(
            data: nil, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(heic as CFURL, UTType.heic.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
        try XCTSkipUnless(CGImageDestinationFinalize(destination), "this Mac cannot write HEIC")

        let file = try XCTUnwrap(CaptureStager(directory: directory).stage(fileAt: heic))

        XCTAssertEqual("IMG_0001.jpg", file.name)
        XCTAssertEqual("image/jpeg", file.contentType)
        let written = try XCTUnwrap(CGImageSourceCreateWithURL(directory.appendingPathComponent("IMG_0001.jpg") as CFURL, nil))
        XCTAssertEqual(UTType.jpeg.identifier, CGImageSourceGetType(written) as String?)
    }

    func testBytesCalledHeicThatAreNotAnImageAreSentAsTheyAre() throws {
        let file = try XCTUnwrap(CaptureStager(directory: directory).stage(fileAt: try source("broken.heic", "not an image")))
        XCTAssertEqual("broken.heic", file.name)
        XCTAssertTrue(staged("broken.heic"))
    }

    // MARK: - A share's items

    private func provider(_ types: [UTType]) -> NSItemProvider {
        let provider = NSItemProvider()
        for type in types {
            provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
                done(Data("x".utf8), nil)
                return nil
            }
        }
        return provider
    }

    func testAPhotoOfferedAsHeicAndJpegIsTakenAsTheJpeg() {
        XCTAssertEqual(.file(.jpeg, load: .jpeg), CaptureStager.kind(of: provider([.heic, .jpeg])))
        XCTAssertEqual(.file(.heic, load: .heic), CaptureStager.kind(of: provider([.heic])))
    }

    func testAFileOfferedWithItsAddressIsAFile() {
        XCTAssertEqual(.file(.pdf, load: .pdf), CaptureStager.kind(of: provider([.fileURL, .pdf])))
        XCTAssertEqual(.file(.data, load: .data), CaptureStager.kind(of: provider([.fileURL])))
    }

    func testALinkAndASelectionAreNotFiles() {
        XCTAssertEqual(.link, CaptureStager.kind(of: provider([.url])))
        XCTAssertEqual(.text, CaptureStager.kind(of: provider([.plainText])))
        XCTAssertEqual(.text, CaptureStager.kind(of: provider([.utf8PlainText])))
        XCTAssertEqual(.nothing, CaptureStager.kind(of: NSItemProvider()))
    }

    func testASharedPageIsItsLinkTitledByWhatThePageIsCalled() async throws {
        let link = NSItemProvider(object: try XCTUnwrap(NSURL(string: "https://www.example.com/a-slug")))

        let intake = await CaptureStager(directory: directory).stage([link], contentText: "An Example Page")

        XCTAssertEqual("https://www.example.com/a-slug", intake.text)
        XCTAssertEqual("An Example Page", intake.title)
        XCTAssertEqual("Link", intake.summary)
    }

    func testALinkSharedWithNothingBesideItIsTitledByItsHost() async throws {
        let link = NSItemProvider(object: try XCTUnwrap(NSURL(string: "https://www.example.com/a-slug")))

        let intake = await CaptureStager(directory: directory).stage([link], contentText: "https://www.example.com/a-slug")

        XCTAssertNil(intake.subject)
        XCTAssertEqual("example.com", intake.title)
    }

    func testASelectionIsTheNotesBodyAndItsFirstLineTheTitle() async {
        let text = NSItemProvider(object: "Pick up prescription\nand call the vet" as NSString)

        let intake = await CaptureStager(directory: directory).stage([text], contentText: nil)

        XCTAssertEqual("Pick up prescription\nand call the vet", intake.text)
        XCTAssertEqual("Pick up prescription", intake.title)
        XCTAssertEqual("Text", intake.summary)
        XCTAssertFalse(intake.isEmpty)
    }

    func testTextAttachedToTheShareItselfIsUsedWhenNothingElseWasShared() async {
        let intake = await CaptureStager(directory: directory).stage([], contentText: "  Just this  ")
        XCTAssertEqual("Just this", intake.text)
    }

    func testFilesFromAShareAreStagedInOrder() async throws {
        let first = try XCTUnwrap(NSItemProvider(contentsOf: try source("a.pdf")))
        let second = try XCTUnwrap(NSItemProvider(contentsOf: try source("b.png")))
        // As a sending app names them: without the extension.
        first.suggestedName = "a"
        second.suggestedName = "b"

        let intake = await CaptureStager(directory: directory).stage([first, second], contentText: nil)

        XCTAssertEqual(["a.pdf", "b.png"], intake.files.map(\.name))
        XCTAssertEqual(["application/pdf", "image/png"], intake.files.map(\.contentType))
        XCTAssertTrue(staged("a.pdf") && staged("b.png"))
        XCTAssertEqual("1 photo · 1 PDF", intake.summary)
    }

    func testNothingSharedIsEmpty() async {
        let intake = await CaptureStager(directory: directory).stage([], contentText: nil)
        XCTAssertTrue(intake.isEmpty)
    }
}
