package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.share.UploadWorker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions a capture makes that need no device: which failures it waits a day
 * through rather than spending one of its four attempts (only a 503 the server sent with
 * a `Retry-After`; any other 503 fails the same way on every try, and waiting on it
 * re-uploads the capture for nothing), which shares are a page for the server to read,
 * and which refusals of that read make the plain note instead.
 */
class UploadWorkerTest {

    @Test
    fun `a 503 that says when to come back is waited out`() {
        assertTrue(UploadWorker.waitsOut(ApiException(503, "unavailable", retryAfter = "60")))
    }

    @Test
    fun `a 503 with no Retry-After spends an attempt like any other failure`() {
        assertFalse(UploadWorker.waitsOut(ApiException(503, "not set up")))
    }

    @Test
    fun `a Retry-After on another status does not buy a wait`() {
        assertFalse(UploadWorker.waitsOut(ApiException(429, "slow down", retryAfter = "60")))
        assertFalse(UploadWorker.waitsOut(ApiException(500, "broken", retryAfter = "60")))
    }

    // Which shares are the page itself, read on the server, rather than text to keep.

    @Test
    fun `one web address and nothing else is a page to clip`() {
        assertEquals("https://example.com/a-slug?x=1", UploadWorker.lonePageUrl("https://example.com/a-slug?x=1"))
        // A browser's share arrives with a newline or two around it.
        assertEquals("http://example.com/", UploadWorker.lonePageUrl("\nhttp://example.com/\n"))
        assertEquals("HTTPS://Example.com/", UploadWorker.lonePageUrl("HTTPS://Example.com/"))
    }

    @Test
    fun `text around a link, two links or no link is a note's body as it was shared`() {
        assertNull(UploadWorker.lonePageUrl("Look at this https://example.com/"))
        assertNull(UploadWorker.lonePageUrl("https://example.com/a\nhttps://example.com/b"))
        assertNull(UploadWorker.lonePageUrl("Pick up prescription"))
        assertNull(UploadWorker.lonePageUrl(""))
    }

    @Test
    fun `an address that is not a web page is not clipped`() {
        assertNull(UploadWorker.lonePageUrl("mailto:someone@example.com"))
        assertNull(UploadWorker.lonePageUrl("ftp://example.com/file"))
        assertNull(UploadWorker.lonePageUrl("https://"))
        assertNull(UploadWorker.lonePageUrl("https://exa mple.com"))
    }

    // Which refusals of a clip make the plain note instead, and which end the capture.

    @Test
    fun `a page the server could not read falls back to a note holding the link`() {
        assertTrue(UploadWorker.clipFallsBack(ApiException(415, "not a page", """{"error":"Not a page","code":"NOT_A_PAGE"}""")))
        assertTrue(UploadWorker.clipFallsBack(ApiException(502, "host failed", """{"error":"The site did not answer","code":"HOST_ERROR"}""")))
        assertTrue(UploadWorker.clipFallsBack(ApiException(413, "too large", """{"error":"Too large","code":"TOO_LARGE"}""")))
        assertTrue(UploadWorker.clipFallsBack(ApiException(400, "bad url", """{"error":"Not an address this server fetches","code":"BAD_URL"}""")))
    }

    /* A page that hangs or kills the Worker never gets an answer `clipFallsBack` can read. */
    @Test
    fun `the last two tries make the plain note rather than lose the link`() {
        assertTrue(UploadWorker.clipsOnAttempt(0))
        assertTrue(UploadWorker.clipsOnAttempt(1))
        assertFalse(UploadWorker.clipsOnAttempt(2))
        assertFalse(UploadWorker.clipsOnAttempt(3))
    }

    @Test
    fun `an instance with no clipper, switched off or from before the route, gets the note too`() {
        assertTrue(UploadWorker.clipFallsBack(ApiException(404, "off", """{"error":"This instance does not clip web pages","code":"CLIP_OFF"}""")))
        // An instance from before the route answers a missing path with no code at all.
        assertTrue(UploadWorker.clipFallsBack(ApiException(404, "not found")))
    }

    @Test
    fun `a refusal every capture already handles is not a reason to make the note instead`() {
        // The plan: the create would be refused the same way.
        assertFalse(UploadWorker.clipFallsBack(ApiException(402, "plan", """{"error":"Your plan has ended","code":"PLAN_INACTIVE"}""")))
        assertFalse(UploadWorker.clipFallsBack(ApiException(401, "unauthorized")))
        assertFalse(UploadWorker.clipFallsBack(ApiException(503, "busy", retryAfter = "60")))
        assertFalse(UploadWorker.clipFallsBack(ApiException(500, "broken")))
    }
}
