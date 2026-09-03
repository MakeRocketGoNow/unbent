package app.unbent.android

import app.unbent.android.api.ApiException
import app.unbent.android.api.Filing
import app.unbent.android.api.UnbentApi
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The exact bytes this client puts on the wire.
 *
 * Worth pinning because every one of these was a requirement discovered in the server: the
 * bearer header, the `Origin` header Better Auth's CSRF check demands, the percent-encoded
 * `X-Filename`, the `link=1` flag without which a shared file is stored but invisible in
 * the note, and a PATCH that names only the fields it means to change.
 */
class UnbentApiTest {

    @get:Rule val temp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var api: UnbentApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = UnbentApi(server.url("/").toString().trimEnd('/'), "test-token")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val note = """{"id":"note-1","title":"Receipt","body":"","updatedAt":1,"createdAt":1,"tags":[],"notebook":null}"""

    @Test
    fun `createNote posts the title and returns the note`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody(note))

        assertEquals("note-1", api.createNote("Receipt", "some text").id)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/notes", req.path)
        assertEquals("Bearer test-token", req.getHeader("Authorization"))
        // Better Auth rejects a request with no trusted Origin as CSRF.
        assertTrue(req.getHeader("Origin")!!.startsWith("http://"))

        val body = req.body.readUtf8()
        assertTrue(body.contains("\"title\":\"Receipt\""))
        assertTrue(body.contains("\"body\":\"some text\""))
        // Notebook is deliberately absent: captures land in the inbox (unfiled).
        assertFalse(body.contains("notebook"))
    }

    @Test
    fun `createNote files and tags the note when asked to`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody(note))

        api.createNote("Receipt", tags = listOf("Invoice", "2026"), notebook = "Taxes")

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"tags\":[\"Invoice\",\"2026\"]"))
        assertTrue(body.contains("\"notebook\":\"Taxes\""))
    }

    @Test
    fun `updateNote sends only the fields it was given`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(note))

        api.updateNote("note-1", title = "Renamed")

        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/notes/note-1", req.path)
        // The body belongs to the WebView; a title edit must not carry a stale copy of it.
        assertEquals("""{"title":"Renamed"}""", req.body.readUtf8())
    }

    @Test
    fun `updateNote says Inbox with an explicit null, and leaves the notebook alone otherwise`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(note))
        server.enqueue(MockResponse().setResponseCode(200).setBody(note))

        api.updateNote("note-1", filing = Filing.INBOX)
        assertEquals("""{"notebook":null}""", server.takeRequest().body.readUtf8())

        api.updateNote("note-1", tags = emptyList())
        assertEquals("""{"tags":[]}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `listNotes passes the cursor and filters through as query parameters`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"items":[{"id":"a","title":"A","updatedAt":2,"createdAt":1}],"cursor":"next","total":10}""",
            ),
        )

        val page = api.listNotes(
            cursor = "c1",
            notebook = "Taxes",
            tags = listOf("Invoice"),
            sort = "title",
        )

        val req = server.takeRequest()
        assertEquals("/api/notes?cursor=c1&notebook=Taxes&tag=Invoice&sort=title&limit=50", req.path)
        assertEquals("a", page.items.single().id)
        assertEquals("next", page.cursor)
        assertEquals(10, page.total)
    }

    /**
     * Several tags go up as the key repeated, which is what the server reads as "all of
     * these". A delimiter would have had to be escaped out of tag names that contain it —
     * this archive has tags with spaces and dots — so the shape is worth pinning.
     */
    @Test
    fun `renameNotebook patches by id`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody("""{"id":"nb-1","name":"Taxes 2024"}"""),
        )

        val renamed = api.renameNotebook("nb-1", "Taxes 2024")

        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        // By id, not by the old name: the id is what survives the rename.
        assertEquals("/api/notebooks/nb-1", req.path)
        assertEquals("""{"name":"Taxes 2024"}""", req.body.readUtf8())
        assertEquals("Taxes 2024", renamed.name)
    }

    /**
     * The server answers a name clash with 409 and an explanation. Pinned because the
     * screen shows that explanation rather than a generic failure — "already exists" tells
     * the user what to do next, where "couldn't rename" sends them to try it again.
     */
    @Test
    fun `renameNotebook surfaces the server's reason for a conflict`() {
        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"A notebook with that name already exists"}"""),
        )

        try {
            api.renameNotebook("nb-1", "Taken")
            fail("expected a conflict")
        } catch (e: ApiException) {
            assertEquals(409, e.status)
            assertEquals("A notebook with that name already exists", e.serverMessage())
        }
    }

    /** The default leaves the notes alone; they become unfiled rather than deleted. */
    @Test
    fun `deleteNotebook unfiles its notes by default`() {
        server.enqueue(MockResponse().setResponseCode(204))

        api.deleteNotebook("nb-1")

        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/api/notebooks/nb-1", req.path)
    }

    /** The cascade is opt-in, and it is trash rather than a purge. */
    @Test
    fun `deleteNotebook asks for the cascade explicitly`() {
        server.enqueue(MockResponse().setResponseCode(204))

        api.deleteNotebook("nb-1", trashNotes = true)

        assertEquals("/api/notebooks/nb-1?trashNotes=1", server.takeRequest().path)
    }

    @Test
    fun `listNotes repeats the tag parameter for each tag`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"items":[],"cursor":null,"total":0}"""))

        api.listNotes(tags = listOf("Receipt", "Medical"))

        assertEquals("/api/notes?tag=Receipt&tag=Medical&limit=50", server.takeRequest().path)
    }

    /** No tags means no parameter at all, not an empty one the server would reject. */
    @Test
    fun `listNotes omits the tag parameter when nothing is selected`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"items":[],"cursor":null,"total":0}"""))

        api.listNotes(notebook = "Taxes")

        assertEquals("/api/notes?notebook=Taxes&limit=50", server.takeRequest().path)
    }

    @Test
    fun `search repeats the tag parameter too`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"results":[]}"""))

        api.search("insurance", tags = listOf("Receipt", "Medical"))

        assertEquals("/api/search?q=insurance&tag=Receipt&tag=Medical", server.takeRequest().path)
    }

    @Test
    fun `listNotes sends a date range as the API's day bounds`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"items":[],"cursor":null,"total":0}"""))

        api.listNotes(sort = "created", from = "2023-01-01", to = "2023-12-31")

        assertEquals("/api/notes?sort=created&from=2023-01-01&to=2023-12-31&limit=50", server.takeRequest().path)
    }

    @Test
    fun `search narrows by the same range as the list`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"results":[]}"""))

        api.search("insurance", notebook = "Taxes", from = "2023-01-01", to = "2023-12-31")

        assertEquals("/api/search?q=insurance&notebook=Taxes&from=2023-01-01&to=2023-12-31", server.takeRequest().path)
    }

    @Test
    fun `a field the server adds later does not break decoding`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"id":"n","title":"T","body":"b","updatedAt":1,"createdAt":1,"brandNew":true}"""),
        )
        assertEquals("b", api.getNote("n").body)
    }

    @Test
    fun `me reports no user rather than failing when the session is gone`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"user":null}"""))
        assertNull(api.me())

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"user":{"id":"u1","email":"a@b.c","name":"A"}}"""))
        assertEquals("a@b.c", api.me()?.email)
    }

    @Test
    fun `uploadFile streams to the note and asks the server to link it`() {
        server.enqueue(
            MockResponse().setResponseCode(201)
                .setBody("""{"filename":"a.pdf","path":"files/a.pdf","indexing":"server"}"""),
        )

        val file = temp.newFile("a.pdf").apply { writeText("%PDF-1.4 hello") }
        val uploaded = api.uploadFile("note-1", file, "a.pdf", "application/pdf")
        assertEquals("a.pdf", uploaded.filename)
        assertEquals(true, uploaded.indexedByServer)

        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/notes/note-1/files?link=1", req.path)
        assertEquals("a.pdf", req.getHeader("X-Filename"))
        assertEquals("application/pdf", req.getHeader("Content-Type"))
        assertEquals("%PDF-1.4 hello", req.body.readUtf8())
    }

    @Test
    fun `uploadFile percent-encodes a filename with spaces and accents`() {
        // An older server says nothing about indexing; that reads as "not by the server".
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"filename":"Café Bill.pdf"}"""))

        val file = temp.newFile("x.pdf").apply { writeText("x") }
        val uploaded = api.uploadFile("note-1", file, "Café Bill.pdf", "application/pdf")
        assertEquals(false, uploaded.indexedByServer)

        // A raw header may not carry non-ASCII; the server decodes this back.
        assertEquals("Caf%C3%A9+Bill.pdf", server.takeRequest().getHeader("X-Filename"))
    }

    @Test
    fun `a failed upload surfaces its status so 401 can be told apart`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Unauthorized"}"""))

        val file = temp.newFile("b.txt").apply { writeText("b") }
        try {
            api.uploadFile("note-1", file, "b.txt", "text/plain")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
        }
    }

    @Test
    fun `the server's own explanation is readable from a refusal`() {
        server.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":"Attachment exceeds 95MB limit"}"""))

        val file = temp.newFile("big.bin").apply { writeText("x") }
        try {
            api.uploadFile("note-1", file, "big.bin", "application/octet-stream")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(413, e.status)
            assertEquals("Attachment exceeds 95MB limit", e.serverMessage())
        }
    }
}
