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

    // MARK: - The plan

    private func refusal(_ body: String?) -> CaptureOutcome {
        CaptureOutcome(status: 402, body: body.map { Data($0.utf8) })
    }

    /// The bodies are the shapes the API writes for each.
    func testA402SaysWhichRoomThePlanHasNoneOf() {
        XCTAssertEqual(.planEnded, CaptureRefusal.of(refusal(#"{"code":"PLAN_INACTIVE","error":"This account is read-only."}"#)))
        XCTAssertEqual(.freeNotesFull, CaptureRefusal.of(refusal(#"{"code":"FREE_NOTES_FULL","error":"The free plan holds up to 100 notes."}"#)))
        XCTAssertEqual(.storageFull, CaptureRefusal.of(refusal(#"{"code":"STORAGE_FULL","of":"files","usedBytes":10737418240,"quotaBytes":10737418240,"error":"Full."}"#)))
        XCTAssertEqual(.notesFull, CaptureRefusal.of(refusal(#"{"code":"STORAGE_FULL","of":"notes","usedBytes":1610612736,"quotaBytes":1610612736,"error":"Full."}"#)))
        // A server from before `of` existed meant the files.
        XCTAssertEqual(.storageFull, CaptureRefusal.of(refusal(#"{"code":"STORAGE_FULL","error":"Full."}"#)))
    }

    /// A newer server's code, a body that is not JSON, or none at all: still the plan's.
    func testA402ThisBuildCannotReadIsStillThePlansRefusal() {
        XCTAssertEqual(.plan, CaptureRefusal.of(refusal(#"{"code":"SOMETHING_NEWER","error":"No."}"#)))
        XCTAssertEqual(.plan, CaptureRefusal.of(refusal("<html>not json</html>")))
        XCTAssertEqual(.plan, CaptureRefusal.of(refusal(nil)))
    }

    func testNoOtherFailureIsARefusalWhateverItsBodySays() {
        let body = Data(#"{"code":"PLAN_INACTIVE"}"#.utf8)
        for status in [400, 401, 413, 500, 503] {
            XCTAssertNil(CaptureRefusal.of(CaptureOutcome(status: status, body: body)), "\(status)")
        }
        XCTAssertNil(CaptureRefusal.of(CaptureOutcome(status: nil)))
    }

    /// Not the capture's failure: nothing is counted, nothing is given up on, and the
    /// same request is what goes again.
    func testACaptureThePlanRefusedIsKeptWholeAndGoesAgain() {
        var fresh = job()
        XCTAssertEqual(.refused(.planEnded, again: false), fresh.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#)))
        XCTAssertEqual(.planEnded, fresh.refused)
        XCTAssertEqual(0, fresh.progress.attempts)
        XCTAssertFalse(fresh.created)
        XCTAssertEqual([.create], fresh.pending(live: []))

        // However often it is asked: a 4xx is otherwise final at once, and four tries are all
        // there are. Each after the first is the same news, to be said quietly.
        for _ in 0..<6 {
            XCTAssertEqual(.refused(.planEnded, again: true), fresh.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#)))
        }
        XCTAssertEqual(0, fresh.progress.attempts)
    }

    /// The note exists and one file is on it when the storage runs out. The file is not
    /// left out, as one refused for its own sake is: it waits with the capture.
    func testAFileRefusedForStorageWaitsRatherThanBeingLeftOut() {
        var job = job()
        _ = job.handle(.create, ok)
        _ = job.handle(.file("file-0"), ok)
        XCTAssertEqual(.refused(.storageFull, again: false), job.handle(.file("file-1"), refusal(#"{"code":"STORAGE_FULL","of":"files"}"#)))
        XCTAssertNotEqual(true, job.file("file-1")?.failed)
        XCTAssertEqual(0, job.filesNotAdded)
        XCTAssertEqual([.file("file-1")], job.pending(live: []))
    }

    /// Once anything is taken there is room, and the capture is an ordinary one again.
    func testTheRefusalIsForgottenWhenTheServerTakesTheCapture() {
        var job = job(files: ["a.pdf"])
        _ = job.handle(.create, refusal(#"{"code":"FREE_NOTES_FULL"}"#))
        XCTAssertEqual(.send([.file("file-0")]), job.handle(.create, ok))
        XCTAssertNil(job.refused)
        XCTAssertEqual(.saved, job.handle(.file("file-0"), ok))
        // What it had been refused for is still known when it lands: there is room of that kind now.
        XCTAssertEqual(.freeNotesFull, job.landedAfter)
        XCTAssertNil(self.job().landedAfter)
    }

    /// The session lapsed while the capture waited on the plan. It is now one waiting for
    /// a sign-in, which is what its notice says, and the resend after signing in is a
    /// first asking again.
    func testARefusedCaptureWhoseSessionThenLapsesWaitsForTheSignInInstead() {
        var job = job()
        _ = job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#))
        XCTAssertEqual(.signInNeeded, job.handle(.create, CaptureOutcome(status: 401)))
        XCTAssertNil(job.refused)
        XCTAssertEqual(.refused(.planEnded, again: false), job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#)))
    }

    /// Files go out together. One that lands after another was refused does not mean
    /// there is room for the refused one.
    func testAnotherFileLandingDoesNotForgetTheRefusal() {
        var job = job(files: ["a.pdf", "b.pdf", "c.pdf"])
        _ = job.handle(.create, ok)
        _ = job.handle(.file("file-1"), refusal(#"{"code":"STORAGE_FULL","of":"files"}"#))
        XCTAssertEqual(.wait, job.handle(.file("file-0"), ok))
        XCTAssertEqual(.storageFull, job.refused)
    }

    /// Coming back to the app asks again. A refused note is cheap to ask about; a file
    /// is uploaded whole to hear the answer and a clip has the server read the page, so
    /// those wait out the rest of a quiet spell first.
    func testARefusedFileOrClipWaitsOutAQuietSpellBeforeItIsSentAgain() {
        let then = Date(timeIntervalSince1970: 1_000_000)
        let soon = then.addingTimeInterval(60)
        let later = then.addingTimeInterval(CaptureJob.refusedQuiet)

        var note = job()
        _ = note.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        XCTAssertEqual(0, note.refusedWait(now: soon))

        var file = job()
        _ = file.handle(.create, ok)
        _ = file.handle(.file("file-0"), refusal(#"{"code":"STORAGE_FULL","of":"files"}"#), now: then)
        XCTAssertEqual(CaptureJob.refusedQuiet - 60, file.refusedWait(now: soon))
        XCTAssertEqual(0, file.refusedWait(now: later))

        var clip = clipJob()
        _ = clip.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        XCTAssertEqual(CaptureJob.refusedQuiet - 60, clip.refusedWait(now: soon))
        // A clock set back since does not hold it until the wall time catches up.
        XCTAssertEqual(0, clip.refusedWait(now: then.addingTimeInterval(-3600)))

        // A capture that was never refused is not held back by any of this.
        XCTAssertEqual(0, job().refusedWait(now: soon))
    }

    /// An account that stays full is asked less and less often, down to four times a day.
    func testEachRefusalDoublesTheQuietSpellUpToSixHours() {
        let then = Date(timeIntervalSince1970: 1_000_000)
        var clip = clipJob()
        _ = clip.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        _ = clip.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        XCTAssertEqual(2 * CaptureJob.refusedQuiet, clip.refusedWait(now: then))
        for _ in 0..<20 { _ = clip.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then) }
        XCTAssertEqual(CaptureJob.refusedQuietMax, clip.refusedWait(now: then))

        // Taken at last: the next refusal, if there is one, starts from the shortest spell.
        var note = clipJob()
        _ = note.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        _ = note.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        _ = note.handle(.create, ok)
        XCTAssertNil(note.refusedCount)
    }

    /// Thirty days from the first refusal, ended by a refusal: the capture's last act is
    /// an asking, not a sweep on the opening of the app that was to have sent it.
    func testAKeptCaptureIsGivenUpOnAtTheFirstRefusalPastThirtyDays() {
        let day: TimeInterval = 24 * 60 * 60
        let first = Date(timeIntervalSince1970: 1_000_000)
        var job = job()
        _ = job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: first)
        XCTAssertEqual(.refused(.planEnded, again: true), job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: first.addingTimeInterval(29 * day)))
        XCTAssertEqual(first, job.refusedSince)
        XCTAssertEqual(.failed, job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: first.addingTimeInterval(31 * day)))
    }

    /// Three files and no room: sent together they are all uploaded to hear one answer.
    /// A refused capture asks with one, and sends the next only when that one is taken.
    func testARefusedCaptureSendsItsFilesOneAtATime() {
        var job = job(files: ["a.pdf", "b.pdf", "c.pdf"])
        _ = job.handle(.create, ok)
        let then = Date(timeIntervalSince1970: 1_000_000)
        _ = job.handle(.file("file-0"), refusal(#"{"code":"STORAGE_FULL","of":"files"}"#), now: then)
        XCTAssertEqual([.file("file-0")], job.pending(live: []))
        // While it is out, nothing joins it.
        XCTAssertEqual([], job.pending(live: ["job-1|file|file-0"]))

        // Sent again once its quiet spell is over, and taken: there is room, so the rest follow.
        let later = then.addingTimeInterval(CaptureJob.refusedQuiet + 5)
        XCTAssertEqual(.send([.file("file-1")]), job.handle(.file("file-0"), ok, now: later))
        XCTAssertEqual(.send([.file("file-2")]), job.handle(.file("file-1"), ok, now: later))
        XCTAssertEqual(.saved, job.handle(.file("file-2"), ok, now: later))
    }

    func testOfManyKeptCapturesOneIsAskedAboutForEachReason() {
        let then = Date(timeIntervalSince1970: 1_000_000)
        func kept(_ id: String, _ body: String, at: TimeInterval, clip: Bool = false) -> CaptureJob {
            var job = clip ? clipJob() : job()
            job.id = id
            _ = job.handle(.create, refusal(body), now: then.addingTimeInterval(at))
            return job
        }
        let ended = #"{"code":"PLAN_INACTIVE"}"#
        let jobs = [
            kept("newer", ended, at: 300),
            kept("oldest", ended, at: 100),
            // Older still, but a clip with a quiet spell to wait out: a note that can go now answers sooner.
            kept("waiting", ended, at: 50, clip: true),
            // Another reason has another answer, so it is asked about too.
            kept("full", #"{"code":"FREE_NOTES_FULL"}"#, at: 200),
            job(),
        ]
        XCTAssertEqual(["oldest", "full"], CaptureJob.firstOfEachRefusal(jobs, now: then.addingTimeInterval(400)))
    }

    /// Four failures end a share made a minute ago. A capture the person was told is
    /// kept is still kept after them, and goes again on a later return to the app.
    func testAKeptCaptureOutOfTriesIsStillKept() {
        let then = Date(timeIntervalSince1970: 1_000_000)
        var job = job()
        _ = job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        for _ in 0..<3 { _ = job.handle(.create, CaptureOutcome(status: 500), now: then) }
        // Back to the notice that says why it is kept, quietly.
        XCTAssertEqual(.refused(.planEnded, again: true), job.handle(.create, CaptureOutcome(status: 500), now: then))
        XCTAssertEqual(.planEnded, job.refused)
        XCTAssertEqual(0, job.progress.attempts)
        XCTAssertEqual([.create], job.pending(live: []))
        // It failed rather than being refused, so even a note now waits out a quiet
        // spell, and one that has not failed is asked about ahead of it.
        XCTAssertEqual(2 * CaptureJob.refusedQuiet, job.refusedWait(now: then))
        var other = self.job()
        other.id = "other"
        _ = other.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then.addingTimeInterval(60))
        XCTAssertEqual(["other"], CaptureJob.firstOfEachRefusal([job, other], now: then.addingTimeInterval(120)))
        // And still behind it once every wait is over, though it has been kept longer.
        XCTAssertEqual(["other"], CaptureJob.firstOfEachRefusal([job, other], now: then.addingTimeInterval(24 * 60 * 60)))
        // A refusal is an answer: it is an ordinary kept capture again.
        var answered = job
        _ = answered.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        XCTAssertEqual(0, answered.refusedWait(now: then))

        // A refusal that will not change is still final, and so is thirty days.
        XCTAssertEqual(.failed, job.handle(.create, CaptureOutcome(status: 400), now: then))
        var old = self.job()
        _ = old.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#), now: then)
        let later = then.addingTimeInterval(31 * 24 * 60 * 60)
        for _ in 0..<3 { _ = old.handle(.create, CaptureOutcome(status: 500), now: later) }
        XCTAssertEqual(.failed, old.handle(.create, CaptureOutcome(status: 500), now: later))
    }

    /// Kept through a sign-out, a capture must not become a note in the library of
    /// whoever signs in next.
    func testAKeptCaptureGoesOnlyAsTheAccountItWasRefusedFor() {
        var kept = job()
        _ = kept.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#))
        // Not asked yet, or the asking failed: it goes as every capture did.
        XCTAssertTrue(kept.mayGo(as: "user-2"))
        XCTAssertTrue(kept.mayGo(as: nil))

        kept.account = "user-1"
        XCTAssertTrue(kept.mayGo(as: "user-1"))
        XCTAssertFalse(kept.mayGo(as: "user-2"))
        // Who is signed in is not known on this pass: it waits for one that knows.
        XCTAssertFalse(kept.mayGo(as: nil))

        // The session runs out while it is kept, which clears the refusal and not the
        // hold: after the sign-in it still goes only as the account it was kept for.
        XCTAssertEqual(.signInNeeded, kept.handle(.create, CaptureOutcome(status: 401)))
        XCTAssertNil(kept.refused)
        XCTAssertFalse(kept.mayGo(as: "user-2"))
        XCTAssertTrue(kept.mayGo(as: "user-1"))

        // Nor does it go again at once with a session that replaced the one it was sent
        // with: it waits for a pass that asks who that is, and the try is not counted.
        XCTAssertEqual(.wait, kept.handle(.create, CaptureOutcome(status: 401, currentSession: false)))
        XCTAssertEqual(0, kept.progress.attempts)

        // Its note taken, its files are held to that account's library too.
        _ = kept.handle(.create, ok)
        XCTAssertFalse(kept.mayGo(as: "user-2"))
        // A capture that was never kept is held to nobody.
        XCTAssertTrue(job().mayGo(as: nil))
    }

    func testAClipThePlanRefusedStaysAClip() {
        var job = clipJob()
        XCTAssertEqual(.refused(.planEnded, again: false), job.handle(.create, refusal(#"{"code":"PLAN_INACTIVE"}"#)))
        XCTAssertNotNil(job.clip)
    }

    func testTheRefusalSurvivesTheRecordOnDiskAndAnOlderRecordHasNone() throws {
        var job = job()
        _ = job.handle(.create, refusal(#"{"code":"STORAGE_FULL","of":"notes"}"#))
        let data = try JSONEncoder().encode(job)
        XCTAssertEqual(.notesFull, try JSONDecoder().decode(CaptureJob.self, from: data).refused)

        var old = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        old.removeValue(forKey: "refused")
        let read = try JSONDecoder().decode(CaptureJob.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertNil(read.refused)
    }

    /// The page replaced the session while the request waited: go again with the new one.
    func testA401ForASessionSinceReplacedGoesAgainAtOnce() {
        var job = job()
        let stale = CaptureOutcome(status: 401, currentSession: false)
        XCTAssertEqual(.retry(.create, after: 0, unavailable: false), job.handle(.create, stale))
        XCTAssertEqual(1, job.progress.attempts)
    }

    // MARK: - A page to clip

    private func clipJob(title: String? = nil) -> CaptureJob {
        CaptureJob(
            id: "job-1",
            origin: "https://notes.example.com",
            noteId: "11111111-1111-4111-8111-111111111111",
            title: "example.com",
            body: "https://example.com/a-slug",
            notebook: "Reading",
            tags: ["read"],
            clip: CaptureJob.Clip(url: "https://example.com/a-slug", title: title)
        )
    }

    /// The server reads the page and makes the note; a clip has no files, so the note is
    /// the whole capture, and it says so as a page.
    func testAClippedPageIsSavedWhenTheServerAnswers() {
        var job = clipJob()
        XCTAssertEqual([.create], job.pending(live: []))
        XCTAssertEqual(.saved, job.handle(.create, ok))
        XCTAssertNotNil(job.clip)
    }

    /// The page could not be read, or the instance has no clipper (404: switched off, or
    /// from before the route): the plain note goes out at once, under the same id, and
    /// the refusal is not one of the capture's four tries.
    func testAPageTheServerCannotReadFallsBackToTheNoteWithItsLink() {
        for status in [400, 404, 413, 415, 502] {
            var job = clipJob(title: "My name")
            XCTAssertEqual(.send([.create]), job.handle(.create, CaptureOutcome(status: status)), "\(status)")
            XCTAssertNil(job.clip)
            XCTAssertEqual(0, job.progress.attempts)
            XCTAssertEqual("11111111-1111-4111-8111-111111111111", job.noteId)
            // And the fallback is an ordinary create from here: a refusal now is final.
            XCTAssertEqual(.failed, job.handle(.create, CaptureOutcome(status: 400)), "\(status)")
        }
    }

    /// What the server says about the account or the session is not about the page.
    func testARefusalEveryCaptureHandlesIsNotAReasonToFallBack() {
        var plan = clipJob()
        XCTAssertEqual(.refused(.plan, again: false), plan.handle(.create, CaptureOutcome(status: 402)))
        XCTAssertNotNil(plan.clip)
        var session = clipJob()
        XCTAssertEqual(.signInNeeded, session.handle(.create, CaptureOutcome(status: 401)))
        XCTAssertNotNil(session.clip)
        var busy = clipJob()
        XCTAssertEqual(.retry(.create, after: 60, unavailable: true), busy.handle(.create, CaptureOutcome(status: 503, retryAfter: "60")))
        XCTAssertNotNil(busy.clip)
        var broken = clipJob()
        XCTAssertEqual(.retry(.create, after: 30, unavailable: false), broken.handle(.create, CaptureOutcome(status: 500)))
        XCTAssertNotNil(broken.clip)
    }

    /// A page that hangs or kills the Worker never gets an answer `clipFallsBack` can
    /// read. Two tries ask for it, and the last two make the note, so the link is kept.
    func testAClipThatKeepsFailingBecomesThePlainNoteBeforeTheTriesRunOut() throws {
        var job = clipJob()
        XCTAssertEqual(.retry(.create, after: 30, unavailable: false), job.handle(.create, CaptureOutcome(status: 500)))
        XCTAssertNotNil(job.clip)
        XCTAssertEqual(.retry(.create, after: 60, unavailable: false), job.handle(.create, CaptureOutcome(status: 500)))
        XCTAssertNil(job.clip)
        XCTAssertEqual("/api/notes", try CaptureRequests.create(job, bearer: "sess.sig").request.url?.path)
        XCTAssertEqual(.retry(.create, after: 120, unavailable: false), job.handle(.create, CaptureOutcome(status: 500)))
        XCTAssertEqual(.saved, job.handle(.create, CaptureOutcome(status: 200)))
    }

    /// A plain capture's 415 is still the final refusal it was.
    func testAPlainNoteRefusedWithA415IsNotRetried() {
        var job = job(files: [])
        XCTAssertEqual(.failed, job.handle(.create, CaptureOutcome(status: 415)))
    }

    /// Longer than the server's own wait on the page, so its answer is what is heard.
    func testAClipWaitsLongerThanTheServerDoesForThePage() throws {
        XCTAssertEqual(180, try CaptureRequests.create(clipJob(), bearer: "sess.sig").request.timeoutInterval)
        XCTAssertEqual(60, try CaptureRequests.create(job(files: []), bearer: "sess.sig").request.timeoutInterval)
    }

    func testAClipAsksTheServerToReadThePageUnderTheIdTheCaptureChose() throws {
        let (request, body) = try CaptureRequests.create(clipJob(), bearer: "sess.sig")

        XCTAssertEqual("POST", request.httpMethod)
        XCTAssertEqual("https://notes.example.com/api/clip", request.url?.absoluteString)
        XCTAssertEqual("Bearer sess.sig", request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual("https://notes.example.com", request.value(forHTTPHeaderField: "Origin"))
        // No title and no body: the page's own title is wanted, and the page is the body.
        XCTAssertEqual(
            #"{"id":"11111111-1111-4111-8111-111111111111","notebook":"Reading","tags":["read"],"url":"https:\/\/example.com\/a-slug"}"#,
            String(decoding: body, as: UTF8.self)
        )
    }

    func testAClipCarriesATitleOnlyWhereThePersonTypedOne() throws {
        let (_, body) = try CaptureRequests.create(clipJob(title: "My name for it"), bearer: "b")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual("My name for it", payload["title"] as? String)
    }

    /// After the fallback the same step is the plain create, with the link as the body.
    func testAClipThatFellBackSendsThePlainNote() throws {
        var job = clipJob()
        _ = job.handle(.create, CaptureOutcome(status: 415))
        let (request, body) = try CaptureRequests.create(job, bearer: "b")
        XCTAssertEqual("https://notes.example.com/api/notes", request.url?.absoluteString)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual("https://example.com/a-slug", payload["body"] as? String)
        XCTAssertEqual("example.com", payload["title"] as? String)
        XCTAssertEqual("11111111-1111-4111-8111-111111111111", payload["id"] as? String)
    }

    /// A record from before pages were clipped is a plain note.
    func testARecordWrittenBeforeClipsExistedIsAPlainNote() throws {
        let old = #"{"id":"j","origin":"https://notes.example.com","noteId":"n","title":"t","body":"https://example.com/","tags":[],"created":false,"progress":{"attempts":0,"unavailable":0},"files":[]}"#
        let job = try JSONDecoder().decode(CaptureJob.self, from: Data(old.utf8))
        XCTAssertNil(job.clip)
        XCTAssertEqual("https://notes.example.com/api/notes", try CaptureRequests.create(job, bearer: "b").request.url?.absoluteString)
    }

    func testAClipSurvivesTheRecordOnDisk() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("unbent-job-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let job = clipJob(title: "Mine")
        try job.save(to: directory)
        XCTAssertEqual(job, CaptureJob.load(from: directory))
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
