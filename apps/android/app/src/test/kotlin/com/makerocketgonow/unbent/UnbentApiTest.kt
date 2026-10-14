package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.UnbentApi
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
    fun `a field the server adds later does not break decoding`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"id":"n","title":"T","body":"b","updatedAt":1,"createdAt":1,"brandNew":true}"""),
        )
        assertEquals("b", api.createNote("T", "b").body)
    }

    @Test
    fun `me reports no user rather than failing when the session is gone`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"user":null}"""))
        assertNull(api.me())

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"user":{"id":"u1","email":"a@b.c","name":"A"}}"""))
        assertEquals("a@b.c", api.me()?.email)
    }

    /**
     * The server answers 503 when it could not check the session at all — a lookup that
     * stalled, or a session store that failed. `MainActivity.checkSession` keeps the stored
     * session on anything but a 401, so this must throw with its status, never read as the
     * null user above, which signs the phone out.
     */
    @Test
    fun `me fails rather than reporting no user when the session could not be checked`() {
        server.enqueue(
            MockResponse().setResponseCode(503).setHeader("Retry-After", "60")
                .setBody("""{"error":"Your session could not be checked right now. Try again shortly."}"""),
        )
        try {
            api.me()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(503, e.status)
        }
    }

    @Test
    fun `listAttachments reads the note's files`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"files":[{"filename":"a.pdf","contentType":"application/pdf","size":12}]}"""),
        )

        val files = api.listAttachments("note-1")
        assertEquals(1, files.size)
        assertEquals("a.pdf", files[0].filename)

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/notes/note-1/files", req.path)
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

    @Test
    fun `a refusal carries the server's Retry-After, and one without it carries none`() {
        server.enqueue(
            MockResponse().setResponseCode(503).setHeader("Retry-After", "60")
                .setBody("""{"error":"Service unavailable"}"""),
        )
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"Reading images is not set up"}"""))

        val first = runCatching { api.createNote("a", "") }.exceptionOrNull() as ApiException
        assertEquals(503, first.status)
        assertEquals("60", first.retryAfter)

        val second = runCatching { api.createNote("b", "") }.exceptionOrNull() as ApiException
        assertEquals(503, second.status)
        assertNull(second.retryAfter)
    }
}
