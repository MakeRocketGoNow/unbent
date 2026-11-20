import Foundation

/// The youngest person the app serves. The terms say the same number, and the two must
/// move together: a gate that let a sixteen-year-old through terms that require eighteen
/// would be the app knowingly serving someone it had said it would not.
///
/// Eighteen rather than COPPA's thirteen, for the reasons given on `MINIMUM_AGE` in the
/// Android app's `AgeGate.kt`: Unbent is a paid archive of receipts and records with no
/// teenage audience, and thirteen would still leave the duties some laws add for anyone
/// under eighteen.
public let minimumAge = 18

/// What the system says about the person on this phone, as far as the gate is concerned.
/// The Android app's `AgeVerdict`, case for case.
public enum AgeVerdict: Equatable, Sendable {
    /// The system shared an age range that starts at `minimumAge` or above.
    case adult
    /// The system shared an age range that ends below `minimumAge`.
    case minor
    /// Nothing the app may act on: no law has the system share an age here, the person
    /// declined, the range straddles `minimumAge`, the system is older than the API, or
    /// it could not be asked at all.
    case unknown
}

/// Reads an age range. Asked with `minimumAge` as its one gate, the system answers a range
/// that is wholly under it or wholly at or over it, so in practice one of the first two
/// cases applies. A range that straddles it is `.unknown` rather than a guess either way.
public func ageVerdict(lower: Int?, upper: Int?) -> AgeVerdict {
    if let upper, upper < minimumAge { return .minor }
    if let lower, lower >= minimumAge { return .adult }
    return .unknown
}

/// What the system answered when asked for a range: the framework's `Response`, with
/// nothing kept but the two bounds the verdict reads.
public enum AgeRangeAnswer: Equatable, Sendable {
    case declined
    case sharing(lower: Int?, upper: Int?)
}

/// The two questions the gate asks the system: Apple's Declared Age Range framework in the
/// app (`DeclaredAgeRanges` there), a fake in the tests.
///
/// A protocol here, and the framework only in the app, because the framework's request
/// needs a view controller to draw its prompt over and this package has no UIKit (see
/// `Package.swift`), and because what the gate does with each answer is the part worth
/// testing on a Mac.
public protocol AgeRangeAsking: Sendable {
    /// Whether a law where the person lives has the system share an age range with apps.
    func isEligible() async throws -> Bool
    /// The person's range, against `gate`. May show the system's own prompt.
    func requestRange(gate: Int) async throws -> AgeRangeAnswer
}

/// Asks the system how old the person on this phone is, where a law makes it say (Texas
/// now, Utah and Louisiana, and California's AB 1043 from January 2027).
///
/// California's law counts what comes back as the developer knowing the person's age, and
/// that knowledge is what turns COPPA on for a general-audience app, so what the system
/// says is acted on rather than merely recorded: a `.minor` is signed out and kept out
/// (`RootViewController.blockForAge` in the app).
///
/// Only where the system reports that a law applies (`isEligible`). Elsewhere asking would
/// put the system's "share your age range?" sheet in front of every adult in the world,
/// for an answer no law asks the app to have. The person is never asked their age by the
/// app itself: a date typed into a box tells the app nothing a child cannot lie about, and
/// costs every adult a step.
///
/// Every failure is `.unknown`, and the app opens. The gate exists to act on what the
/// system knows; when it cannot be asked it knows nothing the app could act on, and an
/// archive that will not open on a train is a much worse fault than the one this guards
/// against. A block already recorded is not lifted by a failure, only by `.adult`.
///
/// What the system returns is used for this decision and nothing else: it is not sent to
/// the server, logged, or kept beyond the one flag (`AppPrefs.ageBlocked`).
public struct AgeGate: Sendable {
    /// Nil where the system has no such framework (before iOS 26.2), which is `.unknown`.
    private let source: AgeRangeAsking?
    private let eligibilityTimeout: Duration

    /// - Parameter eligibilityTimeout: how long the question of whether a law applies may
    ///   take. It shows nothing and should answer at once, but it has been reported to
    ///   never return on some 26.2 builds, and "Check again" shows a spinner for as long
    ///   as it waits. The range request is not bounded: it can be a sheet the person is
    ///   reading, and an answer they are partway through giving is not a failure.
    public init(source: AgeRangeAsking?, eligibilityTimeout: Duration = .seconds(10)) {
        self.source = source
        self.eligibilityTimeout = eligibilityTimeout
    }

    public func check() async -> AgeVerdict {
        guard let source else { return .unknown }
        do {
            guard try await within(eligibilityTimeout, source.isEligible) == true else { return .unknown }
            switch try await source.requestRange(gate: minimumAge) {
            case .declined:
                return .unknown
            case let .sharing(lower, upper):
                return ageVerdict(lower: lower, upper: upper)
            }
        } catch {
            return .unknown
        }
    }
}

/// `work`'s answer, or nil once `limit` has passed.
///
/// Not a task group: a group waits for every child before it returns, so a call that
/// never returns and ignores cancellation (the case this exists for) would hold it as
/// surely as no timeout at all. Whichever finishes first resumes the caller, and the
/// work that lost is cancelled and left to end when it ends.
func within<T: Sendable>(_ limit: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T? {
    let once = Once<T?>()
    return try await withCheckedThrowingContinuation { continuation in
        once.continuation = continuation
        let worker = Task {
            do { once.resume(.success(try await work())) } catch { once.resume(.failure(error)) }
        }
        Task {
            try? await Task.sleep(for: limit)
            once.resume(.success(nil))
            worker.cancel()
        }
    }
}

/// A continuation resumed by the first of several callers, and ignored by the rest.
private final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    var continuation: CheckedContinuation<T, Error>?

    func resume(_ result: Result<T, Error>) {
        lock.lock()
        guard !resumed, let continuation else { lock.unlock(); return }
        resumed = true
        lock.unlock()
        continuation.resume(with: result)
    }
}
