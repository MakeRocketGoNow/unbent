package app.unbent.android

import app.unbent.android.api.ApiException
import app.unbent.android.api.UnbentApi
import java.io.File
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.junit.rules.TemporaryFolder

/**
 * The exact bytes this client puts on the wire.
 *
 * Worth pinning because every one of these was a requirement discovered in the server: the
 * bearer header, the `Origin` header Better Auth's CSRF check demands, the percent-encoded
 * `X-Filename`, and the `link=1` flag without which a shared file is stored but invisible
 * in the note.
 */
/*
 * Robolectric, only for a real org.json: the unit-test JVM stubs Android's bundled
 * copy to return null from every method, and this code parses real API responses.
 */
@RunWith(RobolectricTestRunner::class)
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

    @Test
    fun `createNote posts the title and returns the id`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"note-1","title":"Receipt"}"""))

        assertEquals("note-1", api.createNote("Receipt", "some text"))

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
        assertTrue(!body.contains("notebook"))
    }

    @Test
    fun `uploadFile streams to the note and asks the server to link it`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"filename":"a.pdf","path":"files/a.pdf"}"""))

        val file = temp.newFile("a.pdf").apply { writeText("%PDF-1.4 hello") }
        api.uploadFile("note-1", file, "a.pdf", "application/pdf")

        val req = server.takeRequest()
        assertEquals("PUT", req.method)
        assertEquals("/api/notes/note-1/files?link=1", req.path)
        assertEquals("a.pdf", req.getHeader("X-Filename"))
        assertEquals("application/pdf", req.getHeader("Content-Type"))
        assertEquals("%PDF-1.4 hello", req.body.readUtf8())
    }

    @Test
    fun `uploadFile percent-encodes a filename with spaces and accents`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody("{}"))

        val file = temp.newFile("x.pdf").apply { writeText("x") }
        api.uploadFile("note-1", file, "Café Bill.pdf", "application/pdf")

        // A raw header may not carry non-ASCII; the server decodes this back.
        assertEquals("Caf%C3%A9+Bill.pdf", server.takeRequest().getHeader("X-Filename"))
    }

    @Test
    fun `checkToken reports a dead session rather than throwing`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Unauthorized"}"""))
        assertEquals(false, api.checkToken())

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"notes":[]}"""))
        assertEquals(true, api.checkToken())
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
    fun `a 413 from an oversized file is reported, not retried blindly`() {
        server.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":"Attachment exceeds 95MB limit"}"""))

        val file = temp.newFile("big.bin").apply { writeText("x") }
        try {
            api.uploadFile("note-1", file, "big.bin", "application/octet-stream")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(413, e.status)
            assertTrue(e.message!!.contains("95MB"))
        }
    }
}
