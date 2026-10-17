package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiJson
import com.makerocketgonow.unbent.api.AppConfig
import com.makerocketgonow.unbent.api.EmailOtpAuth
import com.makerocketgonow.unbent.ui.BridgeMessage
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The request for a code, with and without the Turnstile token an instance may ask for
 * with it (MAK-243), and the two shapes that carry the token to it: the config's site key
 * and the page's message.
 */
class EmailOtpAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var auth: EmailOtpAuth

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        auth = EmailOtpAuth(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `asking for a code sends no token where the instance asks for none`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"success":true}"""))

        auth.sendCode("me@example.com")

        val req = server.takeRequest()
        assertEquals("/api/auth/email-otp/send-verification-otp", req.path)
        assertEquals("""{"email":"me@example.com","type":"sign-in"}""", req.body.readUtf8())
        assertNull(req.getHeader(EmailOtpAuth.CAPTCHA_HEADER))
    }

    @Test
    fun `asking for a code carries the token in the header the server reads`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"success":true}"""))

        auth.sendCode("me@example.com", captchaToken = "tok-1")

        val req = server.takeRequest()
        assertEquals("tok-1", req.getHeader("x-captcha-response"))
        assertEquals("""{"email":"me@example.com","type":"sign-in"}""", req.body.readUtf8())
    }

    @Test
    fun `the config names the site key only where the instance has the check on`() {
        val on = ApiJson.decodeFromString<AppConfig>("""{"providers":["email-otp"],"turnstile":{"siteKey":"1x00"}}""")
        assertEquals("1x00", on.turnstile?.siteKey)
        val off = ApiJson.decodeFromString<AppConfig>("""{"providers":["email-otp"]}""")
        assertNull(off.turnstile)
    }

    @Test
    fun `the page's messages carry the token, the failure and the ask for a tap`() {
        val token = ApiJson.decodeFromString<BridgeMessage>("""{"type":"turnstile","token":"tok-1"}""")
        assertEquals(true, token.isTurnstile)
        assertEquals("tok-1", token.token)
        val error = ApiJson.decodeFromString<BridgeMessage>("""{"type":"turnstile-error","message":"The widget could not run."}""")
        assertEquals(true, error.isTurnstileError)
        assertEquals("The widget could not run.", error.message)
        val tap = ApiJson.decodeFromString<BridgeMessage>("""{"type":"turnstile-interactive"}""")
        assertEquals(true, tap.isTurnstileInteractive)
    }
}
