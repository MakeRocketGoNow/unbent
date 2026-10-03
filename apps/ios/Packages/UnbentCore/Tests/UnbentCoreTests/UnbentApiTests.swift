import XCTest
@testable import UnbentCore

/// The API as the native screens call it. Ported from `UnbentApiTest.kt`.
final class UnbentApiTests: XCTestCase {
    private var api: UnbentApi!

    override func setUp() {
        StubServer.reset()
        api = UnbentApi(origin: StubServer.origin, bearer: "sess.sig", session: StubServer.session())
    }

    private let note = #"{"id":"n1","title":"Receipt","body":"","updatedAt":2,"createdAt":1}"#

    func testCreateNotePostsTheTitleAndReturnsTheNote() async throws {
        StubServer.enqueue(.init(body: note))

        let created = try await api.createNote(title: "Receipt")

        XCTAssertEqual("n1", created.id)
        XCTAssertEqual([], created.tags)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("POST", asked.method)
        XCTAssertEqual("/api/notes", asked.path)
        // Every call says who it is and where it comes from; Better Auth refuses one
        // without a trusted Origin as CSRF.
        XCTAssertEqual("Bearer sess.sig", asked.headers["Authorization"])
        XCTAssertEqual(StubServer.origin, asked.headers["Origin"])
        XCTAssertNil(asked.headers["Cookie"])
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(asked.body.utf8)) as? [String: Any])
        XCTAssertEqual("Receipt", sent["title"] as? String)
        XCTAssertNil(sent["notebook"])
        XCTAssertNil(sent["tags"])
    }

    func testCreateNoteFilesAndTagsTheNoteWhenAskedTo() async throws {
        StubServer.enqueue(.init(body: note))

        _ = try await api.createNote(title: "Receipt", tags: ["tax", "2026"], notebook: "Coupons")

        let asked = try StubServer.takeRequest()
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(asked.body.utf8)) as? [String: Any])
        XCTAssertEqual("Coupons", sent["notebook"] as? String)
        XCTAssertEqual(["tax", "2026"], sent["tags"] as? [String])
    }

    func testAFieldTheServerAddsLaterDoesNotBreakDecoding() async throws {
        StubServer.enqueue(.init(body: #"{"providers":["google","email-otp"],"somethingNew":{"a":1}}"#))

        let config = try await UnbentApi(origin: StubServer.origin, bearer: nil, session: StubServer.session()).config()

        XCTAssertTrue(config.google)
        XCTAssertTrue(config.emailOtp)
        XCTAssertFalse(config.password)
        // Before sign-in there is no credential to send.
        XCTAssertNil(try StubServer.takeRequest().headers["Authorization"])
    }

    /// Google and Apple have sheets of their own on a phone; every other provider shares
    /// the browser, however many the instance turned on.
    func testOnlyProvidersWithNoSheetOfTheirOwnCountAsBrowserSocials() {
        let config = AppConfig(providers: ["google", "apple", "github", "discord", "passkey", "email-otp", "password"])
        XCTAssertEqual(2, config.browserSocials)
        XCTAssertTrue(config.apple)
        XCTAssertTrue(config.passkey)
    }

    func testMeReportsNoUserRatherThanFailingWhenTheSessionIsGone() async throws {
        StubServer.enqueue(.init(body: #"{"user":null}"#))
        let gone = try await api.me()
        XCTAssertNil(gone)

        StubServer.enqueue(.init(body: #"{"user":{"id":"u1","email":"me@example.com"}}"#))
        let user = try await api.me()
        XCTAssertEqual("me@example.com", user?.email)
        XCTAssertEqual("", user?.name)
    }

    func testListsNotebooksAndTags() async throws {
        StubServer.enqueue(.init(body: #"{"notebooks":[{"id":"b1","name":"Coupons","count":3},{"id":"b2","name":"Podcast Bookmarks"}],"unfiled":7}"#))
        let notebooks = try await api.listNotebooks()
        XCTAssertEqual(["Coupons", "Podcast Bookmarks"], notebooks.notebooks.map(\.name))
        XCTAssertEqual(0, notebooks.notebooks[1].count)
        XCTAssertEqual(7, notebooks.unfiled)
        XCTAssertEqual("/api/notebooks", try StubServer.takeRequest().path)

        StubServer.enqueue(.init(body: #"{"tags":[{"name":"tax","count":2}]}"#))
        let tags = try await api.listTags()
        XCTAssertEqual(["tax"], tags.map(\.name))
        XCTAssertEqual("/api/tags", try StubServer.takeRequest().path)
    }

    func testListAttachmentsReadsTheNotesFiles() async throws {
        StubServer.enqueue(.init(body: #"{"files":[{"filename":"scan.pdf","contentType":"application/pdf","size":1234}]}"#))

        let files = try await api.listAttachments(noteId: "n1")

        XCTAssertEqual([AttachmentInfo(filename: "scan.pdf", contentType: "application/pdf", size: 1234)], files)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("GET", asked.method)
        XCTAssertEqual("/api/notes/n1/files", asked.path)
    }

    private func temporaryFile(_ bytes: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("unbent-tests-\(UUID().uuidString)")
        try Data(bytes.utf8).write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testUploadFileStreamsToTheNoteAndAsksTheServerToLinkIt() async throws {
        StubServer.enqueue(.init(body: #"{"filename":"scan.pdf","indexing":"server"}"#))

        let stored = try await api.uploadFile(
            noteId: "n1", file: try temporaryFile("%PDF"), filename: "scan.pdf", contentType: "application/pdf"
        )

        XCTAssertTrue(stored.indexedByServer)
        let asked = try StubServer.takeRequest()
        XCTAssertEqual("PUT", asked.method)
        XCTAssertEqual("/api/notes/n1/files?link=1", asked.path)
        XCTAssertEqual("application/pdf", asked.headers["Content-Type"])
        XCTAssertEqual("Bearer sess.sig", asked.headers["Authorization"])
    }

    func testUploadFilePercentEncodesAFilenameWithSpacesAndAccents() async throws {
        StubServer.enqueue(.init(body: #"{"filename":"x"}"#))

        let stored = try await api.uploadFile(
            noteId: "n1", file: try temporaryFile("x"), filename: "Café menu (final).pdf", contentType: "application/pdf"
        )

        // A server older than the field says nothing, which means nobody indexed it yet.
        XCTAssertFalse(stored.indexedByServer)
        let header = try XCTUnwrap(try StubServer.takeRequest().headers["X-Filename"])
        XCTAssertTrue(header.allSatisfy(\.isASCII))
        XCTAssertFalse(header.contains(" "))
        XCTAssertEqual("Café menu (final).pdf", header.removingPercentEncoding)
    }

    func testAFailedUploadSurfacesItsStatusSo401CanBeToldApart() async throws {
        StubServer.enqueue(.init(status: 401, body: #"{"error":"unauthorized"}"#))

        do {
            _ = try await api.uploadFile(noteId: "n1", file: try temporaryFile("x"), filename: "a.pdf", contentType: "application/pdf")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(401, error.status)
        }
    }

    func testTheServersOwnExplanationIsReadableFromARefusal() async throws {
        StubServer.enqueue(.init(status: 409, body: #"{"error":"A notebook with that name already exists."}"#))

        do {
            _ = try await api.createNote(title: "x")
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual("A notebook with that name already exists.", error.serverMessage())
        }
        XCTAssertNil(ApiError(status: 500, message: "x", body: "<html>").serverMessage())
        XCTAssertNil(ApiError(status: 500, message: "x", body: #"{"message":""}"#).serverMessage())
    }

    func testARefusalCarriesTheServersRetryAfterAndOneWithoutItCarriesNone() async throws {
        StubServer.enqueue(.init(status: 503, headers: ["Retry-After": "3600"], body: "{}"))
        do {
            _ = try await api.me()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual("3600", error.retryAfter)
        }

        StubServer.enqueue(.init(status: 503, body: "{}"))
        do {
            _ = try await api.me()
            XCTFail("expected ApiError")
        } catch let error as ApiError {
            XCTAssertNil(error.retryAfter)
        }
    }

    /// The shell tells a server that refused from a phone with no signal by this: no
    /// answer at all is not an `ApiError`.
    func testNoAnswerIsNotAnApiError() async throws {
        do {
            _ = try await api.me()
            XCTFail("expected an error")
        } catch {
            XCTAssertFalse(error is ApiError)
            XCTAssertTrue(error is URLError)
        }
    }
}
