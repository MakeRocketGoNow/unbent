package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.EmailOtpAuth
import com.makerocketgonow.unbent.api.GoogleAuth
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The exchange of a Google ID token for a session, with and without the Turnstile token an
 * instance may ask for with it (MAK-243). The sheet that produces the ID token only a
 * device can draw, so the exchange is tested on its own.
 */
class GoogleAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var auth: GoogleAuth

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        auth = GoogleAuth(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private val sessionLine = "better-auth.session_token=abc.def; Path=/; HttpOnly; SameSite=Lax"

    @Test
    fun `the exchange sends no token where the instance asks for none`() {
        server.enqueue(MockResponse().setResponseCode(200).addHeader("Set-Cookie", sessionLine).setBody("{}"))

        auth.exchange("eyJ.id.token")

        val req = server.takeRequest()
        assertEquals("/api/auth/sign-in/social", req.path)
        assertEquals("""{"provider":"google","idToken":{"token":"eyJ.id.token"}}""", req.body.readUtf8())
        assertNull(req.getHeader(EmailOtpAuth.CAPTCHA_HEADER))
    }

    @Test
    fun `the exchange carries the token in the header the server reads`() {
        server.enqueue(MockResponse().setResponseCode(200).addHeader("Set-Cookie", sessionLine).setBody("{}"))

        auth.exchange("eyJ.id.token", captchaToken = "tok-1")

        val req = server.takeRequest()
        assertEquals("tok-1", req.getHeader("x-captcha-response"))
        assertEquals("""{"provider":"google","idToken":{"token":"eyJ.id.token"}}""", req.body.readUtf8())
    }

    /** The server turned the check on since the config was read: told apart, so the screen reads it again. */
    @Test
    fun `a refusal for a missing token is told apart from every other 400`() {
        server.enqueue(
            MockResponse().setResponseCode(400)
                .setBody("""{"code":"MISSING_RESPONSE","message":"Missing CAPTCHA response"}"""),
        )

        try {
            auth.exchange("eyJ.id.token")
            fail("a 400 must throw")
        } catch (e: ApiException) {
            assertTrue(e.isMissingCaptcha)
        }
    }
}
