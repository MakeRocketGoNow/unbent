package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.api.PasswordAuth
import com.makerocketgonow.unbent.api.SessionCookie
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class PasswordAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var auth: PasswordAuth

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        auth = PasswordAuth(server.url("/").toString().trimEnd('/'))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `signIn posts the credentials with an Origin and keeps the cookie the response set`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .addHeader("Set-Cookie", "better-auth.session_token=sess.sig; Max-Age=2592000; Path=/; HttpOnly")
                .setBody("""{"token":"sess","user":{"id":"u1"}}"""),
        )

        val session = auth.signIn("me@example.com", "hunter22")

        assertEquals(SessionCookie("better-auth.session_token", "sess.sig"), session)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/auth/sign-in/email", req.path)
        assertTrue(req.getHeader("Origin")!!.startsWith("http://"))
        assertEquals("""{"email":"me@example.com","password":"hunter22"}""", req.body.readUtf8())
    }

    @Test
    fun `signUp carries the name Better Auth requires`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .addHeader("Set-Cookie", "better-auth.session_token=sess.sig; Path=/; HttpOnly")
                .setBody("{}"),
        )

        auth.signUp("me@example.com", "hunter22", "Me")

        val req = server.takeRequest()
        assertEquals("/api/auth/sign-up/email", req.path)
        assertTrue(req.body.readUtf8().contains("\"name\":\"Me\""))
    }

    @Test
    fun `a refusal keeps the server's words, so the allowlist can explain itself`() {
        server.enqueue(
            MockResponse().setResponseCode(403)
                .setBody("""{"code":"FORBIDDEN","message":"This Unbent instance is not open for sign-ups."}"""),
        )

        try {
            auth.signUp("stranger@example.com", "hunter22", "Stranger")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(403, e.status)
            assertEquals("This Unbent instance is not open for sign-ups.", e.serverMessage())
        }
    }

    @Test
    fun `a success that sets no cookie is not a sign-in`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"token":"sess"}"""))

        try {
            auth.signIn("me@example.com", "hunter22")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message!!.contains("no session"))
        }
    }
}
