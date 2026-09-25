package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.share.UploadWorker
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which failures a capture waits a day through, rather than spending one of its four
 * attempts: only a 503 the server sent with a `Retry-After`. Any other 503 fails the
 * same way on every try, and waiting on it re-uploads the capture for nothing.
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
}
