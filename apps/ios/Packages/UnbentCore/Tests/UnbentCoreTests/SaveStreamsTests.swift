import XCTest
@testable import UnbentCore

/// The app's half of an export streamed onto the phone. What matters is that the bytes
/// arrive whole and in order, and that a save which does not finish is never kept — a
/// half-written zip in Files would look like a backup and not be one. The first six cases
/// are ported from `SaveStreamsTest.kt`; the rest are the folder iOS writes into.
final class SaveStreamsTests: XCTestCase {

    private final class Fake {
        var bytes = Data()
        var kept = false
        var discarded = false
        var created: String?
        var failWrites = false

        lazy var saves = SaveStreams { [unowned self] name, _ in
            self.created = name
            return SaveStreams.Target(
                write: { data in
                    if self.failWrites { throw CocoaError(.fileWriteOutOfSpace) }
                    self.bytes.append(data)
                },
                close: {},
                keep: { self.kept = true },
                discard: { self.discarded = true }
            )
        }
    }

    private func b64(_ bytes: [UInt8]) -> String { Data(bytes).base64EncodedString() }

    func testPiecesAreWrittenInOrderAndKeptAtTheEnd() {
        let fake = Fake()
        let id = fake.saves.begin(name: "unbent-export-2026-09-25.zip", type: "application/zip")
        XCTAssertTrue(fake.saves.chunk(id: id, base64: b64([1, 2, 3])))
        XCTAssertTrue(fake.saves.chunk(id: id, base64: b64([4, 5])))
        XCTAssertTrue(fake.saves.end(id: id))
        XCTAssertEqual(Data([1, 2, 3, 4, 5]), fake.bytes)
        XCTAssertTrue(fake.kept)
        XCTAssertFalse(fake.discarded)
        XCTAssertEqual("unbent-export-2026-09-25.zip", fake.created)
    }

    func testAnAbandonedSaveIsDiscarded() {
        let fake = Fake()
        let id = fake.saves.begin(name: "a.zip", type: "application/zip")
        _ = fake.saves.chunk(id: id, base64: b64([1]))
        fake.saves.abort(id: id)
        XCTAssertTrue(fake.discarded)
        XCTAssertFalse(fake.kept)
        // Already gone: a second abort or a late piece does nothing and says so.
        fake.saves.abort(id: id)
        XCTAssertFalse(fake.saves.chunk(id: id, base64: b64([2])))
        XCTAssertFalse(fake.saves.end(id: id))
    }

    func testAFailedWriteEndsTheSaveAndThrowsTheFileAway() {
        let fake = Fake()
        let id = fake.saves.begin(name: "a.zip", type: "application/zip")
        fake.failWrites = true
        XCTAssertFalse(fake.saves.chunk(id: id, base64: b64([1])))
        XCTAssertTrue(fake.discarded)
        XCTAssertFalse(fake.saves.end(id: id))
    }

    func testEveryOpenSaveGoesWhenThePageDoes() {
        let fake = Fake()
        _ = fake.saves.begin(name: "a.zip", type: "application/zip")
        fake.saves.abortAll()
        XCTAssertTrue(fake.discarded)
    }

    func testNothingIsPromisedWhenNothingCouldBeCreated() {
        let saves = SaveStreams { _, _ in nil }
        XCTAssertEqual("", saves.begin(name: "a.zip", type: "application/zip"))
    }

    func testANameCannotReachOutsideTheFolderOrHideItself() {
        XCTAssertEqual("passwd", SaveStreams.safeName("../../etc/passwd"))
        XCTAssertEqual("export.zip", SaveStreams.safeName(".export.zip"))
        XCTAssertEqual("a b.zip", SaveStreams.safeName("a\u{0000} b.zip"))
        XCTAssertEqual("unbent-export.zip", SaveStreams.safeName("  "))
    }

    /// The bridge carries text; a piece that is not base64 is a failed write like any other.
    func testAPieceThatIsNotBase64EndsTheSave() {
        let fake = Fake()
        let id = fake.saves.begin(name: "a.zip", type: "application/zip")
        XCTAssertFalse(fake.saves.chunk(id: id, base64: "not base64!"))
        XCTAssertTrue(fake.discarded)
    }

    // MARK: - The folder

    private func folder() -> SavedFiles {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("unbent-tests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return SavedFiles(directory: directory)
    }

    private func visible(_ folder: SavedFiles) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.directory.path)) ?? [])
            .filter { !$0.hasPrefix(".") }
            .sorted()
    }

    func testAnExportIsHiddenWhileItIsWrittenAndNamedOnceWhole() throws {
        let folder = folder()
        var kept: URL?
        let saves = SaveStreams.files(in: folder) { kept = $0 }

        let id = saves.begin(name: "unbent-export.zip", type: "application/zip")
        XCTAssertTrue(saves.chunk(id: id, base64: b64([1, 2])))
        XCTAssertEqual([], visible(folder))

        XCTAssertTrue(saves.chunk(id: id, base64: b64([3])))
        XCTAssertTrue(saves.end(id: id))
        XCTAssertEqual(["unbent-export.zip"], visible(folder))
        XCTAssertEqual(Data([1, 2, 3]), try Data(contentsOf: XCTUnwrap(kept)))
    }

    func testAnAbandonedExportLeavesNothingBehind() {
        let folder = folder()
        let saves = SaveStreams.files(in: folder) { _ in XCTFail("an abandoned save is not kept") }
        let id = saves.begin(name: "a.zip", type: "application/zip")
        _ = saves.chunk(id: id, base64: b64([1]))
        saves.abortAll()
        XCTAssertEqual([], (try? FileManager.default.contentsOfDirectory(atPath: folder.directory.path)) ?? [])
    }

    func testASecondFileOfTheSameNameIsNumberedNotOverwritten() throws {
        let folder = folder()
        XCTAssertEqual("Report.pdf", try folder.keep(folder.partial(), as: "Report.pdf").lastPathComponent)
        XCTAssertEqual("Report (2).pdf", try folder.keep(folder.partial(), as: "Report.pdf").lastPathComponent)
        XCTAssertEqual("Report (3).pdf", try folder.keep(folder.partial(), as: "Report.pdf").lastPathComponent)
        XCTAssertEqual("README", try folder.keep(folder.partial(), as: "README").lastPathComponent)
        XCTAssertEqual("README (2)", try folder.keep(folder.partial(), as: "README").lastPathComponent)
    }

    /// A partial left by a crash is removed at the next launch; a finished file never is.
    func testTheSweepRemovesPartialsAndNothingElse() throws {
        let folder = folder()
        _ = try folder.keep(folder.partial(), as: "kept.zip")
        _ = try folder.partial()
        folder.sweep()
        XCTAssertEqual(["kept.zip"], (try FileManager.default.contentsOfDirectory(atPath: folder.directory.path)))
    }
}
