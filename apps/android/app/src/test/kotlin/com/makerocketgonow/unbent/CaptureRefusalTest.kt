package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiException
import com.makerocketgonow.unbent.share.CaptureRefusal
import com.makerocketgonow.unbent.share.CaptureWork
import com.makerocketgonow.unbent.share.KeptCapture
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    // How often a kept capture is sent again, as the app comes to the screen.

    @Test
    fun `a refused note goes again on every return to the app`() {
        assertEquals(0, CaptureWork.refusedWaitMs(dear = false, refusedAt = 1_000, count = 9, now = 1_001))
    }

    @Test
    fun `a refused file or clip waits out the rest of a quiet spell, and no longer`() {
        val then = 1_000_000L
        val quiet = CaptureWork.REFUSED_QUIET_MS
        assertEquals(quiet - 60_000, CaptureWork.refusedWaitMs(dear = true, refusedAt = then, count = 1, now = then + 60_000))
        assertEquals(0, CaptureWork.refusedWaitMs(dear = true, refusedAt = then, count = 1, now = then + quiet))
        assertEquals(0, CaptureWork.refusedWaitMs(dear = true, refusedAt = then, count = 1, now = then + 10 * quiet))
        // A clock set back since does not hold it: the refusal is then ahead of now.
        assertEquals(0, CaptureWork.refusedWaitMs(dear = true, refusedAt = then, count = 1, now = then - 3_600_000))
    }

    @Test
    fun `an account that stays full is asked less and less often, down to four times a day`() {
        val quiet = CaptureWork.REFUSED_QUIET_MS
        assertEquals(quiet, CaptureWork.quietMs(1))
        assertEquals(2 * quiet, CaptureWork.quietMs(2))
        assertEquals(4 * quiet, CaptureWork.quietMs(3))
        assertEquals(CaptureWork.REFUSED_QUIET_MAX_MS, CaptureWork.quietMs(6))
        assertEquals(CaptureWork.REFUSED_QUIET_MAX_MS, CaptureWork.quietMs(500))
        // A record with a count it should never have still gets the shortest spell, not none.
        assertEquals(quiet, CaptureWork.quietMs(0))
    }

    @Test
    fun `a kept capture goes only to the instance it was shared to`() {
        assertTrue(CaptureWork.sameInstance("https://notes.example.com", "https://notes.example.com/"))
        assertFalse(CaptureWork.sameInstance("https://notes.example.com", "http://localhost:5236"))
        // A marker with no instance on it is not sent anywhere on a guess.
        assertFalse(CaptureWork.sameInstance(null, "https://notes.example.com"))
    }

    @Test
    fun `another account's kept capture is passed over once the app knows who is signed in`() {
        assertTrue(CaptureWork.sameAccount("user-1", "user-1"))
        assertFalse(CaptureWork.sameAccount("user-1", "user-2"))
        // Not known yet on either side: the worker asks the server before sending.
        assertTrue(CaptureWork.sameAccount(null, "user-2"))
        assertTrue(CaptureWork.sameAccount("user-1", null))
    }

    @Test
    fun `of many kept captures, one is asked about for each reason they were refused`() {
        fun kept(name: String, refusal: CaptureRefusal, since: Long, waitMs: Long = 0) = CaptureWork.Waiting(
            File(name), null, KeptCapture(refusal.name, "https://notes.example.com", since = since), waitMs,
        )
        val chosen = CaptureWork.firstOfEach(
            listOf(
                kept("newer", CaptureRefusal.PLAN_ENDED, since = 300),
                kept("oldest", CaptureRefusal.PLAN_ENDED, since = 100),
                // Older still, but a scan that has an hour to wait: a note that can go now answers sooner.
                kept("waiting", CaptureRefusal.PLAN_ENDED, since = 50, waitMs = 3_600_000),
                // Another reason has another answer, so it is asked about too.
                kept("scan", CaptureRefusal.STORAGE_FULL, since = 200, waitMs = 60_000),
            ),
        )
        assertEquals(setOf("oldest", "scan"), chosen.map { it.dir.name }.toSet())
    }
}
