package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.SessionCookie
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reading the credential out of a sign-in response.
 *
 * Every case here is a way the wrong cookie could be stored: the session-data cache that
 * Better Auth sets beside the session, a deletion that carries the session's own name, or
 * a name guessed for the wrong kind of origin.
 */
class SessionCookieTest {

    @Test
    fun `picks the session out of everything a sign-in sets`() {
        val headers = listOf(
            "better-auth.session_data=eyJzZXNzaW9uIjp7fX0; Max-Age=300; Path=/; HttpOnly; SameSite=Lax",
            "better-auth.session_token=abc123.c2ln; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
        )
        assertEquals(
            SessionCookie("better-auth.session_token", "abc123.c2ln"),
            SessionCookie.fromSetCookie(headers),
        )
    }

    @Test
    fun `keeps the secure prefix an https instance uses`() {
        val headers = listOf(
            "__Secure-better-auth.session_token=abc.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
        )
        assertEquals("__Secure-better-auth.session_token", SessionCookie.fromSetCookie(headers)?.name)
    }

    @Test
    fun `a deletion is not a session`() {
        val headers = listOf("better-auth.session_token=; Max-Age=0; Path=/; HttpOnly")
        assertNull(SessionCookie.fromSetCookie(headers))
    }

    @Test
    fun `a deletion with a stale value is not a session either`() {
        val headers = listOf("better-auth.session_token=old.sig; Max-Age=0; Path=/; HttpOnly")
        assertNull(SessionCookie.fromSetCookie(headers))
    }

    @Test
    fun `nothing set means nothing found`() {
        assertNull(SessionCookie.fromSetCookie(emptyList()))
        assertNull(SessionCookie.fromSetCookie(listOf("better-auth.state=; Max-Age=0; Path=/")))
    }

    @Test
    fun `the bearer credential is the signed value as set`() {
        assertEquals("abc.sig", SessionCookie("n", "abc.sig").bearer)
    }

    @Test
    fun `marks the cookie Secure only on an https origin`() {
        val cookie = SessionCookie("__Secure-better-auth.session_token", "abc.sig")
        val https = cookie.setCookieLine("https://unbent.app")
        val http = cookie.setCookieLine("http://10.0.2.2:5173")

        assertTrue(https.startsWith("__Secure-better-auth.session_token=abc.sig; Path=/; HttpOnly"))
        assertTrue(https.endsWith("; Secure"))
        // The name keeps its prefix either way; only the attribute is conditional.
        assertFalse(http.endsWith("; Secure"))
        assertTrue(http.endsWith("; Path=/; HttpOnly"))
    }
}
