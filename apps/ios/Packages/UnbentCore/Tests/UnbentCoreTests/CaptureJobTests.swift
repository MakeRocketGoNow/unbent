import XCTest
@testable import UnbentCore

/// A capture's progress from Save to "Saved", as the results of its requests are applied.
///
/// The cases `UploadWorkerTest.kt` and `CaptureResumeTest.kt` hold for Android are here in
/// the shape this queue has: which failures are waited out, that a capture resumes the
/// same note rather than making another, and that a file already on it is not sent again.
final class CaptureJobTests: XCTestCase {

    private func job(files: [String] = ["a.pdf", "b.jpg"]) -> CaptureJob {
        CaptureJob(
            id: "job-1",
            origin: "https://notes.example.com",
            noteId: "11111111-1111-4111-8111-111111111111",
            title: "Receipts",
            body: "https://example.com/x",
            notebook: "Coupons",
            tags: ["2026"],
            files: files.enumerated().map { CaptureJob.File(id: "file-\($0.offset)", name: $0.element, contentType: "application/pdf") }
        )
    }

    private let ok = CaptureOutcome(status: 201)

    // MARK: - The ordinary path

    func testTheNoteIsMadeFirstAndItsFilesFollow() {
        var job = job()
        XCTAssertEqual([.create], job.pending(live: []))

        XCTAssertEqual(.send([.file("file-0"), .file("file-1")]), job.handle(.create, ok))
        XCTAssertTrue(job.created)

        XCTAssertEqual(.wait, job.handle(.file("file-1"), ok))
        XCTAssertEqual(.saved, job.handle(.file("file-0"), ok))
        XCTAssertTrue(job.isSaved)
    }

    func testACaptureOfOnlyTextIsSavedWhenTheNoteIs() {
        var job = job(files: [])
        XCTAssertEqual(.saved, job.handle(.create, ok))
    }

    /// The extension's request and the app's resend of it can both be answered.
    func testTheNoteAnsweredTwiceDoesNotSendItsFilesTwice() {
        var job = job()
        _ = job.handle(.create, ok)
        XCTAssertEqual(.wait, job.handle(.create, CaptureOutcome(status: 200)))
    }

    // MARK: - Resuming

    func testACaptureWhoseNoteIsStillOutSendsNothingMore() {
        XCTAssertEqual([], job().pending(live: ["job-1|create"]))
    }

    func testFilesAlreadyOnTheNoteAreNotUploadedAgain() {
        var job = job()
        _ = job.handle(.create, ok)
        _ = job.handle(.file("file-0"), ok)
        XCTAssertEqual([.file("file-1")], job.pending(live: []))
    }

    func testAFileTheSystemIsStillCarryingIsNotSentASecondTime() {
        var job = job()
        _ = job.handle(.create, ok)
        XCTAssertEqual([.file("file-0")], job.pending(live: ["job-1|file|file-1"]))
        // Another capture's request is not this one's.
        XCTAssertEqual([.file("file-0"), .file("file-1")], job.pending(live: ["job-2|file|file-1"]))
    }

    func testAFullyLandedCaptureHasNothingLeft() {
        var job = job(files: ["a.pdf"])
        _ = job.handle(.create, ok)
        _ = job.handle(.file("file-0"), ok)
        XCTAssertEqual([], job.pending(live: []))
        XCTAssertTrue(job.isSaved)
    }

    func testAFileThatHasGoneFromTheDirectoryIsSkippedNotFatal() {
        var job = job()
        _ = job.handle(.create, ok)
        XCTAssertEqual(.wait, job.skip("file-0"))
        XCTAssertEqual(.saved, job.skip("file-1"))
    }

    // MARK: - Failures

    func testA503ThatSaysWhenToComeBackIsWaitedOut() {
        XCTAssertTrue(CaptureJob.waitsOut(CaptureOutcome(status: 503, retryAfter: "60")))
    }

    func testA503WithNoRetryAfterSpendsAnAttemptLikeAnyOtherFailure() {
        XCTAssertFalse(CaptureJob.waitsOut(CaptureOutcome(status: 503)))
    }

    func testARetryAfterOnAnotherStatusDoesNotBuyAWait() {
        XCTAssertFalse(CaptureJob.waitsOut(CaptureOutcome(status: 429, retryAfter: "60")))
        XCTAssertFalse(CaptureJob.waitsOut(CaptureOutcome(status: 500, retryAfter: "60")))
    }

    func testAnOrdinaryFailureIsTriedFourTimesBackingOff() {
        var job = job()
        let broken = CaptureOutcome(status: 500)
        XCTAssertEqual(.retry(.create, after: 30, unavailable: false), job.handle(.create, broken))
        XCTAssertEqual(.retry(.create, after: 60, unavailable: false), job.handle(.create, broken))
        XCTAssertEqual(.retry(.create, after: 120, unavailable: false), job.handle(.create, broken))
        XCTAssertEqual(.failed, job.handle(.create, broken))
    }

    func testARequestThatGotNoAnswerIsAFailureLikeAnyOther() {
        var job = job()
        XCTAssertEqual(.retry(.create, after: 30, unavailable: false), job.handle(.create, CaptureOutcome(status: nil)))
    }

    /// One file's bad luck is not another's: each has four tries of its own.
    func testEachFileHasItsOwnAttempts() {
        var job = job()
        _ = job.handle(.create, ok)
        let broken = CaptureOutcome(status: 500)
        for _ in 0..<3 { _ = job.handle(.file("file-0"), broken) }
        XCTAssertEqual(.retry(.file("file-1"), after: 30, unavailable: false), job.handle(.file("file-1"), broken))
    }

    /// The note exists by then, so the capture is saved without the file, and says so.
    func testAFileOutOfTriesIsLeftOutAndTheRestOfTheCaptureGoesOn() {
        var job = job()
        _ = job.handle(.create, ok)
        let broken = CaptureOutcome(status: 500)
        for _ in 0..<3 { _ = job.handle(.file("file-0"), broken) }

        XCTAssertEqual(.wait, job.handle(.file("file-0"), broken))
        XCTAssertEqual([.file("file-1")], job.pending(live: []))
        XCTAssertEqual(.saved, job.handle(.file("file-1"), ok))
        XCTAssertEqual(1, job.filesNotAdded)
    }

    func testARefusalThatWillNotChangeIsNotTriedAgain() {
        for status in [400, 404, 413, 415] {
            var job = job()
            XCTAssertEqual(.failed, job.handle(.create, CaptureOutcome(status: status)), "\(status)")
            XCTAssertEqual(1, job.progress.attempts)
        }
        // A file the server will not take is left out on the first answer.
        var job = job(files: ["a.pdf"])
        _ = job.handle(.create, ok)
        XCTAssertEqual(.saved, job.handle(.file("file-0"), CaptureOutcome(status: 413)))
        XCTAssertEqual(1, job.filesNotAdded)
    }

    func testATimeoutAndATooManyAreStillTriedAgain() {
        for status in [408, 429] {
            var job = job()
            XCTAssertEqual(.retry(.create, after: 30, unavailable: false), job.handle(.create, CaptureOutcome(status: status)), "\(status)")
        }
    }

    func testARecordWrittenBeforeFilesCouldBeLeftOutStillReads() throws {
        let old = #"{"id":"j","origin":"https://notes.example.com","noteId":"n","title":"t","body":"","tags":[],"created":true,"progress":{"attempts":0,"unavailable":0},"files":[{"id":"f","name":"a.pdf","contentType":"application/pdf","done":false,"progress":{"attempts":0,"unavailable":0}}]}"#
        let job = try JSONDecoder().decode(CaptureJob.self, from: Data(old.utf8))
        XCTAssertEqual(0, job.filesNotAdded)
        XCTAssertEqual([.file("f")], job.pending(live: []))
    }

    func testAServerAskingForTimeDoesNotSpendAnAttempt() {
        var job = job()
        let busy = CaptureOutcome(status: 503, retryAfter: "3600")
        XCTAssertEqual(.retry(.create, after: 3600, unavailable: true), job.handle(.create, busy))
        XCTAssertEqual(0, job.progress.attempts)
        XCTAssertEqual(1, job.progress.unavailable)
        // And an ordinary failure afterwards is still only the first.
        XCTAssertEqual(.retry(.create, after: 30, unavailable: false), job.handle(.create, CaptureOutcome(status: 500)))
    }

    func testFourteenWaitsAreAllowedAndTheFifteenthGivesUp() {
        var job = job()
        let busy = CaptureOutcome(status: 503, retryAfter: "60")
        for _ in 0..<14 {
            XCTAssertEqual(.retry(.create, after: 60, unavailable: true), job.handle(.create, busy))
        }
        XCTAssertEqual(.failed, job.handle(.create, busy))
    }

    func testTheWaitIsWhatTheServerAskedForWithinReason() {
        let now = Date(timeIntervalSince1970: 1_788_273_000)
        XCTAssertEqual(900, CaptureJob.wait(retryAfter: "900", now: now))
        // Too eager, and too patient.
        XCTAssertEqual(60, CaptureJob.wait(retryAfter: "0", now: now))
        XCTAssertEqual(6 * 60 * 60, CaptureJob.wait(retryAfter: "604800", now: now))
        // The other form the header takes: a date, here half an hour on.
        XCTAssertEqual(1800, CaptureJob.wait(retryAfter: "Tue, 01 Sep 2026 15:00:00 GMT", now: now))
        // Nothing readable is the shortest wait, not none.
        XCTAssertEqual(60, CaptureJob.wait(retryAfter: "soon", now: now))
    }

    func testA401ForTheSessionThisPhoneHoldsMeansSigningInAgain() {
        var job = job()
        XCTAssertEqual(.signInNeeded, job.handle(.create, CaptureOutcome(status: 401)))
    }

    /// A lapsed session is not the capture's failure. It is left exactly as it was, so
    /// that after a sign-in it is sent like one made while signed out.
    func testACaptureRefusedForItsSessionIsKeptWholeForTheNextSignIn() {
        var fresh = job()
        let before = fresh
        XCTAssertEqual(.signInNeeded, fresh.handle(.create, CaptureOutcome(status: 401)))
        XCTAssertEqual(before, fresh)
        XCTAssertEqual([.create], fresh.pending(live: []))

        // Refused partway: the note and the file that landed stay landed.
        var partway = job()
        _ = partway.handle(.create, ok)
        _ = partway.handle(.file("file-0"), ok)
        XCTAssertEqual(.signInNeeded, partway.handle(.file("file-1"), CaptureOutcome(status: 401)))
        XCTAssertEqual(0, partway.file("file-1")?.progress.attempts)
        XCTAssertEqual([.file("file-1")], partway.pending(live: []))
    }

    /// The page replaced the session while the request waited: go again with the new one.
    func testA401ForASessionSinceReplacedGoesAgainAtOnce() {
        var job = job()
        let stale = CaptureOutcome(status: 401, currentSession: false)
        XCTAssertEqual(.retry(.create, after: 0, unavailable: false), job.handle(.create, stale))
        XCTAssertEqual(1, job.progress.attempts)
    }

    // MARK: - Labels, and the record on disk

    func testARequestsLabelNamesItsCaptureAndStep() {
        XCTAssertEqual("job-1|create", CaptureStep.create.key(job: "job-1"))
        XCTAssertEqual("job-1|file|f", CaptureStep.file("f").key(job: "job-1"))
        XCTAssertEqual("job-1", CaptureStep.parse("job-1|create")?.job)
        XCTAssertEqual(.create, CaptureStep.parse("job-1|create")?.step)
        XCTAssertEqual(.file("f"), CaptureStep.parse("job-1|file|f")?.step)
        XCTAssertNil(CaptureStep.parse(nil))
        XCTAssertNil(CaptureStep.parse("unbent.flush"))
        XCTAssertNil(CaptureStep.parse("|create"))
    }

    func testTheRecordSurvivesTheProcessThatWroteIt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("unbent-job-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(CaptureJob.load(from: directory))

        var job = job()
        _ = job.handle(.create, ok)
        _ = job.handle(.file("file-0"), CaptureOutcome(status: 503, retryAfter: "60"))
        job.shareSession = "example.capture.share.job-1"
        try job.save(to: directory)

        XCTAssertEqual(job, CaptureJob.load(from: directory))
    }

    func testIdsAreLowercaseUuidsWhichIsTheFormTheApiAccepts() {
        let id = CaptureJob.newId()
        XCTAssertEqual(id.lowercased(), id)
        XCTAssertNotNil(UUID(uuidString: id))
    }

    // MARK: - The requests

    func testTheNoteIsCreatedUnderTheIdTheCaptureChose() throws {
        let (request, body) = try CaptureRequests.create(job(), bearer: "sess.sig")

        XCTAssertEqual("POST", request.httpMethod)
        XCTAssertEqual("https://notes.example.com/api/notes", request.url?.absoluteString)
        XCTAssertEqual("Bearer sess.sig", request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual("https://notes.example.com", request.value(forHTTPHeaderField: "Origin"))
        XCTAssertEqual(
            #"{"body":"https:\/\/example.com\/x","id":"11111111-1111-4111-8111-111111111111","notebook":"Coupons","tags":["2026"],"title":"Receipts"}"#,
            String(decoding: body, as: UTF8.self)
        )
    }

    func testAnInboxCaptureWithNoTagsSendsNeither() throws {
        var job = job()
        job.notebook = nil
        job.tags = []
        let (_, body) = try CaptureRequests.create(job, bearer: "b")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNil(payload["notebook"])
        XCTAssertNil(payload["tags"])
    }

    func testAFileGoesToItsNoteUnderItsOwnIdAndAsksToBeLinked() throws {
        let job = job()
        let file = CaptureJob.File(id: "22222222-2222-4222-8222-222222222222", name: "Reçu (final) v2.pdf", contentType: "application/pdf")

        let request = try CaptureRequests.upload(file, of: job, bearer: "sess.sig")

        XCTAssertEqual("PUT", request.httpMethod)
        XCTAssertEqual(
            "https://notes.example.com/api/notes/11111111-1111-4111-8111-111111111111/files?link=1",
            request.url?.absoluteString
        )
        XCTAssertEqual("application/pdf", request.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertEqual("22222222-2222-4222-8222-222222222222", request.value(forHTTPHeaderField: "X-Attachment-Id"))
        // Percent-encoded: a header cannot carry the ç, and the server decodes it.
        let name = try XCTUnwrap(request.value(forHTTPHeaderField: "X-Filename"))
        XCTAssertEqual("Reçu (final) v2.pdf", name.removingPercentEncoding)
        XCTAssertTrue(name.allSatisfy(\.isASCII))
        XCTAssertEqual("Re%C3%A7u%20(final)%20v2.pdf", name)
        XCTAssertEqual("Bearer sess.sig", request.value(forHTTPHeaderField: "Authorization"))
    }

    /// Letters are letters in every script, and none of them may reach a header raw: the
    /// curly apostrophe is what an iPhone's keyboard types.
    func testAFilenameInAnyScriptIsAsciiInTheHeaderAndDecodesToItself() throws {
        for original in ["Café ’receipt’.pdf", "領収書 2026.pdf", "Счёт №5.pdf"] {
            let file = CaptureJob.File(name: original, contentType: "application/pdf")
            let name = try XCTUnwrap(CaptureRequests.upload(file, of: job(), bearer: "b").value(forHTTPHeaderField: "X-Filename"))
            XCTAssertTrue(name.allSatisfy(\.isASCII), name)
            XCTAssertEqual(original, name.removingPercentEncoding)
        }
    }
}
