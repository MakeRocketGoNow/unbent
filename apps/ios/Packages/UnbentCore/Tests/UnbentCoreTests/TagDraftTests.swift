import XCTest
@testable import UnbentCore

/// A tag typed but never confirmed with the keyboard's return key must still reach the
/// note when the sheet's own button is tapped. Ported from `TagEditorTest.kt`.
final class TagDraftTests: XCTestCase {

    func testATagStillInTheFieldGoesWithTheNote() {
        XCTAssertEqual(["Receipts"], tagsWithDraft([], "Receipts"))
        XCTAssertEqual(["Dentist", "2026"], tagsWithDraft(["Dentist"], "  2026 "))
    }

    func testAnEmptyFieldChangesNothing() {
        XCTAssertEqual(["Dentist"], tagsWithDraft(["Dentist"], ""))
        XCTAssertEqual(["Dentist"], tagsWithDraft(["Dentist"], "   "))
    }

    func testATagTheNoteAlreadyHasIsNotAddedTwiceWhateverItsCase() {
        XCTAssertEqual(["Dentist"], tagsWithDraft(["Dentist"], "dentist"))
    }

    private func tags(_ names: [String]) throws -> [Tag] {
        try names.map { try JSONDecoder().decode(Tag.self, from: Data(#"{"name":"\#($0)","count":1}"#.utf8)) }
    }

    func testSuggestionsLeaveOutWhatTheNoteHasAndNarrowAsItIsTyped() throws {
        let all = try tags(["Dentist", "Receipts", "2026", "Recipes"])
        XCTAssertEqual(["Receipts", "2026", "Recipes"], tagSuggestions(all, tags: ["dentist"], draft: ""))
        XCTAssertEqual(["Receipts", "Recipes"], tagSuggestions(all, tags: [], draft: " rec"))
        XCTAssertEqual([], tagSuggestions(all, tags: [], draft: "zzz"))
    }

    func testSuggestionsStopAtADozen() throws {
        let all = try tags((1...30).map { "tag-\($0)" })
        XCTAssertEqual(12, tagSuggestions(all, tags: [], draft: "").count)
    }
}
