package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.share.CaptureRefusal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which of the server's answers mean "the plan has no room for this", and which room.
 * Those captures are kept and their notice names the reason; everything else is a failure
 * like any other. The bodies are the shapes the API writes (`plan-middleware.ts`,
 * `free-plan.ts` and `storageFullBody` there).
 */
class CaptureRefusalTest {

    private fun refused(body: String) = CaptureRefusal.of(ApiException(402, "refused", body))

    @Test
    fun `a plan that has ended is told from a plan that is full`() {
        assertEquals(CaptureRefusal.PLAN_ENDED, refused("""{"code":"PLAN_INACTIVE","error":"This account is read-only."}"""))
        assertEquals(CaptureRefusal.FREE_NOTES_FULL, refused("""{"code":"FREE_NOTES_FULL","error":"The free plan holds up to 100 notes."}"""))
    }

    @Test
    fun `full storage says whether it is the files or the notes`() {
        assertEquals(
            CaptureRefusal.STORAGE_FULL,
            refused("""{"code":"STORAGE_FULL","of":"files","usedBytes":10737418240,"quotaBytes":10737418240,"error":"Full."}"""),
        )
        assertEquals(
            CaptureRefusal.NOTES_FULL,
            refused("""{"code":"STORAGE_FULL","of":"notes","usedBytes":1610612736,"quotaBytes":1610612736,"error":"Full."}"""),
        )
        // A server from before `of` existed meant the files.
        assertEquals(CaptureRefusal.STORAGE_FULL, refused("""{"code":"STORAGE_FULL","error":"Full."}"""))
    }

    @Test
    fun `a 402 this build cannot read is still the plan's refusal, and kept`() {
        assertEquals(CaptureRefusal.PLAN, refused("""{"code":"SOMETHING_NEWER","error":"No."}"""))
        assertEquals(CaptureRefusal.PLAN, refused(""))
        assertEquals(CaptureRefusal.PLAN, refused("<html>not json</html>"))
    }

    @Test
    fun `no other failure is a refusal, whatever its body says`() {
        assertNull(CaptureRefusal.of(ApiException(400, "bad", """{"code":"PLAN_INACTIVE"}""")))
        assertNull(CaptureRefusal.of(ApiException(401, "unauthorized")))
        assertNull(CaptureRefusal.of(ApiException(413, "too large")))
        assertNull(CaptureRefusal.of(ApiException(503, "busy", retryAfter = "60")))
    }
}
