import XCTest
@testable import UnbentCore

/// The page's messages, as the app reads them.
///
/// The protocol is a handful of JSON shapes agreed with apps/web/src/app-bridge.ts; what
/// is worth pinning is that each field is read only with the type it belongs to, and that
/// a message with more in it than this build knows still parses: a page from a newer
/// deploy must not break the screen around it. Ported from `NoteBridgeTest.kt` and
/// `PageColourTest.kt`.
final class BridgeMessageTests: XCTestCase {

    func testAMessageFromANewerPageStillParses() {
        let message = BridgeMessage.parse(#"{"type":"index-done","indexed":2,"unusable":0,"failed":0,"seconds":4}"#)
        XCTAssertEqual(2, message?.indexed)
    }

    func testAnIndexDoneMessageCarriesItsCounts() {
        let message = BridgeMessage.parse(#"{"type":"index-done","indexed":3,"unusable":1,"failed":0}"#)
        XCTAssertEqual(true, message?.isIndexDone)
        XCTAssertEqual(3, message?.indexed)
        XCTAssertEqual(1, message?.unusable)
        XCTAssertEqual(0, message?.failed)
        XCTAssertNil(message?.message)
    }

    /// The Turnstile page's three words (MAK-243).
    func testTheTurnstilePagesMessagesCarryTheTokenTheFailureAndTheAskForATap() {
        let token = BridgeMessage.parse(#"{"type":"turnstile","token":"tok-1"}"#)
        XCTAssertEqual(true, token?.isTurnstile)
        XCTAssertEqual("tok-1", token?.token)
        let error = BridgeMessage.parse(#"{"type":"turnstile-error","message":"The widget could not run."}"#)
        XCTAssertEqual(true, error?.isTurnstileError)
        XCTAssertEqual("The widget could not run.", error?.message)
        XCTAssertEqual(true, BridgeMessage.parse(#"{"type":"turnstile-interactive"}"#)?.isTurnstileInteractive)
    }

    func testAnIndexErrorMessageCarriesWhatWentWrong() {
        let message = BridgeMessage.parse(#"{"type":"index-error","message":"R2 is on fire"}"#)
        XCTAssertEqual(true, message?.isIndexError)
        XCTAssertEqual("R2 is on fire", message?.message)
        XCTAssertNil(message?.indexed)
    }

    func testAThemeMessageCarriesThePagesGroundAndNothingElse() {
        let message = BridgeMessage.parse(##"{"type":"theme","background":"#16151a"}"##)
        XCTAssertEqual("#16151a", message?.themeBackground)
        XCTAssertNil(message?.indexed)
        XCTAssertNil(message?.message)
    }

    func testABackgroundOutsideAThemeMessageIsNotATheme() {
        XCTAssertNil(BridgeMessage.parse(##"{"type":"ready","background":"#000000"}"##)?.themeBackground)
    }

    func testTheSitesSignOutAndSettingsRequestsParse() {
        XCTAssertEqual(true, BridgeMessage.parse(#"{"type":"signed-out"}"#)?.isSignedOut)
        XCTAssertEqual(true, BridgeMessage.parse(#"{"type":"app-settings"}"#)?.isAppSettings)
        XCTAssertEqual(true, BridgeMessage.parse(#"{"type":"unauthorized"}"#)?.isUnauthorized)
    }

    /// The page asks for the whole screen; a page that says anything else has not.
    func testAPageAsksForTheWholeScreenInSoManyWords() {
        XCTAssertEqual(true, BridgeMessage.parse(#"{"type":"edge-to-edge"}"#)?.isEdgeToEdge)
        XCTAssertEqual(false, BridgeMessage.parse(##"{"type":"theme","background":"#fbfaf8"}"##)?.isEdgeToEdge)
    }

    func testWhatIsNotAMessageIsIgnored() {
        XCTAssertNil(BridgeMessage.parse("not json"))
        XCTAssertNil(BridgeMessage.parse(##"{"background":"#000000"}"##))
        XCTAssertNil(BridgeMessage.parse(#"["theme"]"#))
    }

    func testReadsThePagesHex() {
        let light = PageColour(hex: "#fbfaf8")
        XCTAssertEqual(251.0 / 255, light?.red)
        XCTAssertEqual(250.0 / 255, light?.green)
        XCTAssertEqual(248.0 / 255, light?.blue)
        XCTAssertEqual(PageColour(hex: "#16151a"), PageColour(hex: " #16151A "))
    }

    func testIgnoresAnythingElse() {
        XCTAssertNil(PageColour(hex: "rgb(22, 21, 26)"))
        XCTAssertNil(PageColour(hex: "#fff"))
        XCTAssertNil(PageColour(hex: "#gggggg"))
        XCTAssertNil(PageColour(hex: ""))
    }

    /// The clock is drawn over the strip painted in this colour, so the two themes'
    /// grounds must come out on opposite sides.
    func testTheSitesTwoGroundsAskForOppositeStatusBars() {
        XCTAssertEqual(false, PageColour(hex: "#fbfaf8")?.isDark)
        XCTAssertEqual(true, PageColour(hex: "#16151a")?.isDark)
    }
}
