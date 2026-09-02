package app.unbent.android

import app.unbent.android.api.ApiException
import app.unbent.android.api.ConnectAuth
import app.unbent.android.api.SessionCookie
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/*
 * Robolectric, only for a real org.json: the unit-test JVM stubs Android's bundled copy to
 * return null from every method, and this code parses real API responses.
 */
@RunWith(RobolectricTestRunner::class)
class ConnectAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var auth: ConnectAuth

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        auth = ConnectAuth(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `the connect url carries the app's own redirect, encoded`() {
        val url = auth.connectUrl("unbent")
        assertTrue(url.startsWith(server.url("/").toString().trimEnd('/') + "/connect?"))
        // Encoded, or the slashes would terminate the query value early.
        assertTrue(url.contains("redirect=unbent%3A%2F%2Fconnect"))
    }

    @Test
    fun `the debug build asks to be redirected to its own scheme`() {
        assertTrue(auth.connectUrl("unbent-debug").contains("unbent-debug%3A%2F%2Fconnect"))
    }

    @Test
    fun `redeem yields the session cookie the response set, not the token in its body`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .addHeader(
                    "Set-Cookie",
                    "better-auth.session_token=sess-abc.sig; Max-Age=2592000; Path=/; HttpOnly",
                )
                .setBody("""{"session":{"token":"sess-abc","userId":"u1"},"user":{"id":"u1"}}"""),
        )

        assertEquals(
            SessionCookie("better-auth.session_token", "sess-abc.sig"),
            auth.redeem("one-time-xyz"),
        )

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/auth/one-time-token/verify", req.path)
        // Better Auth rejects a request with no trusted Origin as CSRF.
        assertTrue(req.getHeader("Origin")!!.startsWith("http://"))
        assertTrue(req.body.readUtf8().contains("one-time-xyz"))
    }

    @Test
    fun `a spent or forged token is reported, not treated as success`() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"message":"Invalid token"}"""))

        try {
            auth.redeem("already-used")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(400, e.status)
        }
    }

    @Test
    fun `a response that sets no session cookie fails rather than storing an empty credential`() {
        // A body with a session but no Set-Cookie: the token alone is not the credential.
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setBody("""{"session":{"token":"sess-abc"},"user":{"id":"u1"}}"""),
        )

        try {
            auth.redeem("odd-response")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message!!.contains("Unexpected"))
        }
    }
}
