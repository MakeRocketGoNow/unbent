import XCTest
@testable import UnbentCore

/// What the gate does with each answer the system can give, ported from the Android app's
/// `AgeGateTest.kt`. The framework itself cannot run here (it needs an iPhone on 26.2 and a
/// sandbox account), so a fake stands in for it, and these are about the gate's choices.
final class AgeGateTests: XCTestCase {

    func testABracketWhollyUnderEighteenIsAMinor() {
        XCTAssertEqual(.minor, ageVerdict(lower: nil, upper: 17))
        XCTAssertEqual(.minor, ageVerdict(lower: 13, upper: 15))
        XCTAssertEqual(.minor, ageVerdict(lower: 0, upper: 12))
    }

    func testEighteenAndOverIsAnAdult() {
        XCTAssertEqual(.adult, ageVerdict(lower: 18, upper: nil))
    }

    func testNoRangeOrOneThatStraddlesEighteenIsNotActedOn() {
        XCTAssertEqual(.unknown, ageVerdict(lower: nil, upper: nil))
        XCTAssertEqual(.unknown, ageVerdict(lower: 16, upper: nil))
    }

    func testWhereTheSystemSharesAMinorsRangeTheCheckSaysSo() async {
        let fake = FakeAgeRanges(answer: .sharing(lower: 13, upper: 15))
        let verdict = await AgeGate(source: fake).check()
        XCTAssertEqual(.minor, verdict)
        XCTAssertEqual([minimumAge], fake.gatesAsked)
    }

    func testWhereTheSystemSharesAnAdultsRangeTheCheckSaysSo() async {
        let verdict = await AgeGate(source: FakeAgeRanges(answer: .sharing(lower: 18, upper: nil))).check()
        XCTAssertEqual(.adult, verdict)
    }

    /// The point of asking only where a law applies: adults elsewhere never see a prompt.
    func testWhereNoLawAppliesNothingIsRequested() async {
        let fake = FakeAgeRanges(eligible: false, answer: .sharing(lower: 13, upper: 15))
        let verdict = await AgeGate(source: fake).check()
        XCTAssertEqual(.unknown, verdict)
        XCTAssertEqual([], fake.gatesAsked)
    }

    func testSomeoneWhoDeclinedToShareIsLetIn() async {
        let verdict = await AgeGate(source: FakeAgeRanges(answer: .declined)).check()
        XCTAssertEqual(.unknown, verdict)
    }

    func testTheSystemFailingOpensTheApp() async {
        let eligibility = await AgeGate(source: FakeAgeRanges(eligibleError: Failure())).check()
        XCTAssertEqual(.unknown, eligibility)
        let request = await AgeGate(source: FakeAgeRanges(requestError: Failure())).check()
        XCTAssertEqual(.unknown, request)
    }

    /// Before iOS 26.2 there is no framework to ask.
    func testNoFrameworkIsUnknown() async {
        let verdict = await AgeGate(source: nil).check()
        XCTAssertEqual(.unknown, verdict)
    }

    /// The eligibility call has been reported never to return on some builds. Check
    /// again's spinner waits on it, so it must end, and end as a failure does.
    func testAnEligibilityQuestionThatNeverAnswersEndsAsUnknown() async {
        let fake = FakeAgeRanges(eligibleHangs: true, answer: .sharing(lower: 13, upper: 15))
        let started = Date()
        let verdict = await AgeGate(source: fake, eligibilityTimeout: .milliseconds(50)).check()
        XCTAssertEqual(.unknown, verdict)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual([], fake.gatesAsked)
    }
}

private struct Failure: Error {}

private final class FakeAgeRanges: AgeRangeAsking, @unchecked Sendable {
    private let eligible: Bool
    private let eligibleError: Error?
    private let eligibleHangs: Bool
    private let answer: AgeRangeAnswer
    private let requestError: Error?
    private let lock = NSLock()
    private var asked: [Int] = []

    init(
        eligible: Bool = true,
        eligibleError: Error? = nil,
        eligibleHangs: Bool = false,
        answer: AgeRangeAnswer = .declined,
        requestError: Error? = nil
    ) {
        self.eligible = eligible
        self.eligibleError = eligibleError
        self.eligibleHangs = eligibleHangs
        self.answer = answer
        self.requestError = requestError
    }

    var gatesAsked: [Int] { lock.withLock { asked } }

    func isEligible() async throws -> Bool {
        if eligibleHangs {
            // Ignores cancellation, as a system call stuck in another process would.
            await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
        }
        if let eligibleError { throw eligibleError }
        return eligible
    }

    func requestRange(gate: Int) async throws -> AgeRangeAnswer {
        lock.withLock { asked.append(gate) }
        if let requestError { throw requestError }
        return answer
    }
}
