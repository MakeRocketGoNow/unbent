package app.unbent.android

import app.unbent.android.api.DeviceAuth
import app.unbent.android.api.SignInResult
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The polling loop, driven without ever sleeping for real.
 *
 * The cases that matter are the ones RFC 8628 spells out and a naive client gets wrong:
 * `authorization_pending` is not an error, `slow_down` must raise the interval permanently,
 * and both arrive as HTTP 400 bodies rather than as successes.
 */
/*
 * Robolectric, only for a real org.json: the unit-test JVM stubs Android's bundled
 * copy to return null from every method, and this code parses real API responses.
 */
@RunWith(RobolectricTestRunner::class)
class DeviceAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var auth: DeviceAuth

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        auth = DeviceAuth(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun grant() = auth.requestCode()

    private fun enqueueCode() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"device_code":"dev-1","user_code":"WXYZ-1234",
                   "verification_uri":"https://unbent.app/device",
                   "expires_in":1800,"interval":5}""",
            ),
        )
    }

    @Test
    fun `requestCode sends the client id and parses the grant`() {
        enqueueCode()
        val g = grant()

        assertEquals("dev-1", g.deviceCode)
        assertEquals("WXYZ-1234", g.userCode)
        assertEquals(5L, g.intervalSeconds)

        val req = server.takeRequest()
        assertEquals("/api/auth/device/code", req.path)
        // JSON, not form encoding: the endpoint answers 415 to the RFC's own encoding.
        assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
        assertTrue(req.body.readUtf8().contains("unbent-android"))
    }

    @Test
    fun `keeps polling through pending, then returns the token`() {
        enqueueCode()
        val g = grant()

        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"authorization_pending"}"""))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"authorization_pending"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"access_token":"sess-abc","token_type":"bearer"}"""))

        val slept = mutableListOf<Long>()
        val result = auth.awaitToken(g, sleep = { slept.add(it) })

        assertEquals(SignInResult.Success("sess-abc"), result)
        assertEquals(listOf(5000L, 5000L, 5000L), slept)
    }

    @Test
    fun `slow_down raises the interval for every later poll, not just one`() {
        enqueueCode()
        val g = grant()

        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"slow_down"}"""))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"authorization_pending"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"access_token":"sess-xyz"}"""))

        val slept = mutableListOf<Long>()
        auth.awaitToken(g, sleep = { slept.add(it) })

        // 5s, then +5 permanently: a one-shot backoff would read 5, 10, 5.
        assertEquals(listOf(5000L, 10000L, 10000L), slept)
    }

    @Test
    fun `a denial stops the loop`() {
        enqueueCode()
        val g = grant()
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"access_denied"}"""))

        assertEquals(SignInResult.Denied, auth.awaitToken(g, sleep = {}))
    }

    @Test
    fun `an expired code stops the loop`() {
        enqueueCode()
        val g = grant()
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"expired_token"}"""))

        assertEquals(SignInResult.Expired, auth.awaitToken(g, sleep = {}))
    }

    @Test
    fun `gives up once the grant's own deadline passes`() {
        enqueueCode()
        val g = grant()

        var clock = 0L
        val result = auth.awaitToken(g, now = { clock }, sleep = { clock += 1_000_000 })

        assertEquals(SignInResult.Expired, result)
    }

    @Test
    fun `cancellation stops the loop without consuming a poll`() {
        enqueueCode()
        val g = grant()

        val result = auth.awaitToken(g, isCancelled = { true }, sleep = {})
        assertTrue(result is SignInResult.Failed)
        assertEquals(0, server.requestCount - 1)
    }

    @Test
    fun `approvalUrl carries the code so the user does not retype it`() {
        enqueueCode()
        val g = grant()
        assertTrue(auth.approvalUrl(g).contains("WXYZ-1234"))
    }
}
