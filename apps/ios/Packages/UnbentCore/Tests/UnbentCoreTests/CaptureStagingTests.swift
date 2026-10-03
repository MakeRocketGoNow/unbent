import XCTest
@testable import UnbentCore

/// Filename and title derivation, and the directory captures wait in. Ported from
/// `StagingTest.kt`.
///
/// These run without a simulator because the rules they encode come from the server: the
/// API rejects path separators, `.`, `..` and leading dots, and a rejected name silently
/// loses the file the person just shared.
final class CaptureStagingTests: XCTestCase {

    func testKeepsAnOrdinaryFilename() {
        XCTAssertEqual("receipt.pdf", CaptureNaming.sanitize("receipt.pdf", index: 0, fallbackExtension: "bin"))
    }

    func testStripsAPathKeepingOnlyTheName() {
        XCTAssertEqual("photo.jpg", CaptureNaming.sanitize("/var/mobile/Media/DCIM/photo.jpg", index: 0, fallbackExtension: "bin"))
        XCTAssertEqual("photo.jpg", CaptureNaming.sanitize("C:\\Users\\me\\photo.jpg", index: 0, fallbackExtension: "bin"))
    }

    func testStripsLeadingDotsWhichTheApiRejects() {
        XCTAssertEqual("hidden.png", CaptureNaming.sanitize(".hidden.png", index: 0, fallbackExtension: "bin"))
    }

    func testFallsBackWhenTheNameIsMissingOrDegenerate() {
        XCTAssertEqual("capture-1.jpg", CaptureNaming.sanitize(nil, index: 0, fallbackExtension: "jpg"))
        XCTAssertEqual("capture-2.jpg", CaptureNaming.sanitize("", index: 1, fallbackExtension: "jpg"))
        XCTAssertEqual("capture-3.pdf", CaptureNaming.sanitize("..", index: 2, fallbackExtension: "pdf"))
        XCTAssertEqual("capture-1.jpg", CaptureNaming.sanitize(".", index: 0, fallbackExtension: "jpg"))
    }

    func testAddsAnExtensionWhenTheNameHasNone() {
        XCTAssertEqual("scan.pdf", CaptureNaming.sanitize("scan", index: 0, fallbackExtension: "pdf"))
    }

    func testRemovesControlCharacters() {
        XCTAssertEqual("abc.txt", CaptureNaming.sanitize("a\u{0}b\u{1f}c.txt", index: 0, fallbackExtension: "bin"))
    }

    func testCapsAnAbsurdlyLongNameAndKeepsItsExtension() {
        let long = String(repeating: "x", count: 400) + ".pdf"
        let capped = CaptureNaming.sanitize(long, index: 0, fallbackExtension: "bin")
        XCTAssertEqual(200, capped.count)
        XCTAssertTrue(capped.hasSuffix(".pdf"))
    }

    func testTwoFilesOfOneNameInAShareGetDistinctNames() {
        var used = Set<String>()
        XCTAssertEqual("image.jpg", CaptureNaming.uniquify("image.jpg", used: &used))
        XCTAssertEqual("image-2.jpg", CaptureNaming.uniquify("image.jpg", used: &used))
        XCTAssertEqual("image-3.jpg", CaptureNaming.uniquify("image.jpg", used: &used))
        XCTAssertEqual("notes", CaptureNaming.uniquify("notes", used: &used))
        XCTAssertEqual("notes-2", CaptureNaming.uniquify("notes", used: &used))
    }

    /// The phone's file system does not tell these apart, so neither may the names.
    func testNamesThatDifferOnlyInCaseAreTheSameName() {
        var used = Set<String>()
        XCTAssertEqual("scan.pdf", CaptureNaming.uniquify("scan.pdf", used: &used))
        XCTAssertEqual("Scan-2.pdf", CaptureNaming.uniquify("Scan.pdf", used: &used))
    }

    func testATranscodedPhotoIsNamedForWhatItNowIs() {
        XCTAssertEqual("IMG_0001.jpg", CaptureNaming.jpegName("IMG_0001.HEIC", index: 0))
        XCTAssertEqual("capture-2.jpg", CaptureNaming.jpegName(nil, index: 1))
    }

    func testPrefersTheSubjectForTheTitle() {
        XCTAssertEqual("Lab results", CaptureNaming.deriveTitle(subject: "  Lab results  ", filenames: ["photo.jpg"]))
    }

    func testUsesALoneFilenameStemWhenThereIsNoSubject() {
        XCTAssertEqual("receipt", CaptureNaming.deriveTitle(subject: nil, filenames: ["receipt.pdf"]))
    }

    private let utc = TimeZone(identifier: "UTC")!
    /// 2026-09-01 14:30 UTC.
    private let afternoon = Date(timeIntervalSince1970: 1_788_273_000)

    func testFallsBackToADatedTitleForAMultiFileShare() {
        XCTAssertEqual(
            "Capture 2026-09-01 14:30",
            CaptureNaming.deriveTitle(subject: nil, filenames: ["a.jpg", "b.jpg"], now: afternoon, timeZone: utc)
        )
    }

    func testFallsBackToADatedTitleWhenThereIsNothingToGoOn() {
        XCTAssertTrue(CaptureNaming.deriveTitle(subject: "", filenames: [], text: "  ").hasPrefix("Capture "))
    }

    func testTitlesASharedLinkByItsHostWhichIsWhatAPersonRecognises() {
        XCTAssertEqual(
            "example.com",
            CaptureNaming.deriveTitle(subject: nil, filenames: [], text: "https://www.example.com/2026/09/01/a-slug")
        )
    }

    func testTitlesPlainTextByItsFirstLine() {
        XCTAssertEqual(
            "Pick up prescription",
            CaptureNaming.deriveTitle(subject: nil, filenames: [], text: "Pick up prescription\nand call the vet")
        )
    }

    func testTheSubjectStillWinsOverEverythingElse() {
        XCTAssertEqual(
            "Lab results",
            CaptureNaming.deriveTitle(subject: "Lab results", filenames: ["a.pdf"], text: "https://example.com")
        )
    }

    func testFindsAHostInsideSurroundingTextAndNothingWhenThereIsNoUrl() {
        XCTAssertEqual("example.com", CaptureNaming.hostOf("look at https://example.com/x please"))
        XCTAssertNil(CaptureNaming.hostOf("no link here at all"))
    }

    func testTheSummarySaysWhatWasSharedByKind() {
        XCTAssertEqual("2 photos · 1 PDF", CaptureNaming.summary(contentTypes: ["image/jpeg", "image/png", "application/pdf"], hasText: false))
        XCTAssertEqual("1 photo · 1 file", CaptureNaming.summary(contentTypes: ["image/jpeg", "video/mp4"], hasText: true))
        XCTAssertEqual("Text", CaptureNaming.summary(contentTypes: [], hasText: true))
    }

    // MARK: - The directory

    private var container: URL!

    override func setUpWithError() throws {
        container = FileManager.default.temporaryDirectory.appendingPathComponent("unbent-capture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: container)
    }

    func testACaptureIsStagedUnderSharesInTheContainer() throws {
        let store = CaptureStore(container: container)
        let directory = try store.create("job-1")
        XCTAssertEqual(container.appendingPathComponent("shares/job-1").path, directory.path)
        XCTAssertEqual(["job-1"], store.jobIds())
        store.clear("job-1")
        XCTAssertEqual([], store.jobIds())
    }

    func testAJobUntouchedForDaysIsSweptAndOneStillWaitingIsLeft() throws {
        let store = CaptureStore(container: container)
        let day: TimeInterval = 24 * 60 * 60
        let now = Date()
        func touch(_ url: URL, _ date: Date) throws {
            try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        }

        let abandoned = try store.create("old")
        let stale = abandoned.appendingPathComponent("scan.pdf")
        try Data("x".utf8).write(to: stale)
        try touch(stale, now - 4 * day)
        try touch(abandoned, now - 4 * day)

        // Staged four days ago too, but a file written an hour ago says it is live.
        let waiting = try store.create("waiting")
        let file = waiting.appendingPathComponent("scan.pdf")
        try Data("x".utf8).write(to: file)
        try touch(file, now - 4 * day)
        let record = waiting.appendingPathComponent(".note")
        try Data("{}".utf8).write(to: record)
        try touch(record, now - 60 * 60)
        try touch(waiting, now - 4 * day)

        XCTAssertEqual([], store.sweepAbandoned(now: now))

        XCTAssertEqual(["waiting"], store.jobIds())
    }

    /// Saved while signed out: the sheet said it would be saved, so it is kept far longer
    /// than a sheet nobody finished, and is not let go of without a word.
    func testASavedCaptureWaitsAMonthForASignInAndIsReportedWhenItGoes() throws {
        let store = CaptureStore(container: container)
        let day: TimeInterval = 24 * 60 * 60
        let now = Date()
        func stage(_ id: String, daysAgo: Double) throws {
            let directory = try store.create(id)
            try CaptureJob(id: id, origin: "https://notes.example.com", title: "Receipts").save(to: directory)
            for url in [directory.appendingPathComponent(".job.json"), directory] {
                try FileManager.default.setAttributes([.modificationDate: now - daysAgo * day], ofItemAtPath: url.path)
            }
        }
        try stage("last-week", daysAgo: 7)
        try stage("long-ago", daysAgo: 31)

        let givenUp = store.sweepAbandoned(now: now)

        XCTAssertEqual(["long-ago"], givenUp.map(\.id))
        XCTAssertEqual(["last-week"], store.jobIds())
    }
}
