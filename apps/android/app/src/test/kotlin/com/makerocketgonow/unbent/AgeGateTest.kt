package com.makerocketgonow.unbent

import android.content.Intent
import android.os.Looper
import androidx.activity.ComponentActivity
import com.google.android.play.agesignals.AgeSignalsAccessResult
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsResult
import com.google.android.play.agesignals.ApplicableAgeFeaturesResult
import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import com.google.android.play.agesignals.testing.FakeAgeSignalsManager
import com.makerocketgonow.unbent.api.SessionCookie
import com.makerocketgonow.unbent.share.ShareActivity
import com.makerocketgonow.unbent.ui.AgeBlockedActivity
import com.makerocketgonow.unbent.ui.AgeGate
import com.makerocketgonow.unbent.ui.AgeVerdict
import com.makerocketgonow.unbent.ui.enforceAgeGate
import com.makerocketgonow.unbent.ui.keepSignIn
import com.makerocketgonow.unbent.ui.verdictOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/*
 * Robolectric for an Activity to hand Play, and for the main looper that Play's tasks call
 * back on. The fake is the library's own, so these follow what Play's client does with
 * each answer, not a mock's idea of it.
 */
@RunWith(RobolectricTestRunner::class)
class AgeGateTest {

    private fun range(lower: Int?, upper: Int?): AgeSignalsResult =
        AgeSignalsResult.builder().setAgeLower(lower).setAgeUpper(upper).setInstallId("install").build()

    @Test
    fun `a bracket wholly under eighteen is a minor`() {
        assertEquals(AgeVerdict.Minor, verdictOf(range(0, 12)))
        assertEquals(AgeVerdict.Minor, verdictOf(range(13, 15)))
        assertEquals(AgeVerdict.Minor, verdictOf(range(16, 17)))
    }

    @Test
    fun `eighteen and over is an adult`() {
        assertEquals(AgeVerdict.Adult, verdictOf(range(18, null)))
    }

    @Test
    fun `no range, or one that straddles eighteen, is not acted on`() {
        assertEquals(AgeVerdict.Unknown, verdictOf(range(null, null)))
        assertEquals(AgeVerdict.Unknown, verdictOf(range(16, null)))
    }

    private fun fake(
        mandatory: Boolean = true,
        status: Int = AgeSignalsStatus.SHARED,
        result: AgeSignalsResult? = null,
    ) = FakeAgeSignalsManager().apply {
        val features = if (mandatory) setOf(ApplicableAgeFeature.MANDATORY_SHARING) else emptySet()
        setNextApplicableAgeFeaturesResult(ApplicableAgeFeaturesResult.builder().setFeatures(features).build())
        setNextAgeSignalsAccessResult(AgeSignalsAccessResult.builder().setAgeSignalsStatus(status).build())
        result?.let { setNextAgeSignalsResult(it) }
    }

    /** Runs the check to its end, letting Play's callbacks through the main looper. */
    private fun check(manager: FakeAgeSignalsManager): AgeVerdict? {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        var verdict: AgeVerdict? = null
        CoroutineScope(Dispatchers.Unconfined).launch { verdict = AgeGate(manager).check(activity) }
        repeat(10) { shadowOf(Looper.getMainLooper()).idle() }
        return verdict
    }

    @Test
    fun `where Play shares a minor's range, the check says so`() {
        assertEquals(AgeVerdict.Minor, check(fake(result = range(13, 15))))
    }

    @Test
    fun `where Play shares an adult's range, the check says so`() {
        assertEquals(AgeVerdict.Adult, check(fake(result = range(18, null))))
    }

    @Test
    fun `where no law has Play share an age, nothing is asked and nothing is known`() {
        // A minor's range waiting behind the access call proves it was never reached.
        assertEquals(AgeVerdict.Unknown, check(fake(mandatory = false, result = range(13, 15))))
    }

    @Test
    fun `someone who has not verified with Play is let in, not refused`() {
        assertEquals(
            AgeVerdict.Unknown,
            check(fake(status = AgeSignalsStatus.VERIFICATION_REQUIRED, result = range(13, 15))),
        )
    }

    @Test
    fun `someone who declined to share is let in`() {
        assertEquals(AgeVerdict.Unknown, check(fake(status = AgeSignalsStatus.NOT_SHARED, result = range(13, 15))))
    }

    @Test
    fun `Play failing, as on a sideloaded build, opens the app`() {
        val manager = FakeAgeSignalsManager().apply {
            setNextApplicableAgeFeaturesException(AgeSignalsException(AgeSignalsErrorCode.APP_NOT_OWNED))
        }
        assertEquals(AgeVerdict.Unknown, check(manager))
    }

    // The half that enforces: what a verdict does to the phone, not what the verdict is.

    private fun idle() = repeat(10) { shadowOf(Looper.getMainLooper()).idle() }

    private fun signedIn(activity: ComponentActivity) {
        Prefs(activity).session = SessionCookie("session", "token")
    }

    @Test
    fun `a minor is recorded, signed out and sent to the blocked screen`() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        signedIn(activity)
        assertFalse(activity.enforceAgeGate { AgeGate(fake(result = range(13, 15))) })
        idle()
        val prefs = Prefs(activity)
        assertTrue(prefs.ageBlocked)
        assertNull(prefs.session)
        assertEquals(AgeBlockedActivity::class.java.name, shadowOf(activity).nextStartedActivity?.component?.className)
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `a recorded block stops the launch without asking Play`() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        Prefs(activity).ageBlocked = true
        assertTrue(activity.enforceAgeGate { fail("Play was asked"); error("unreachable") })
        assertEquals(AgeBlockedActivity::class.java.name, shadowOf(activity).nextStartedActivity?.component?.className)
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `no answer from Play leaves the person signed in and the app open`() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        signedIn(activity)
        assertFalse(activity.enforceAgeGate { AgeGate(fake(mandatory = false)) })
        idle()
        assertFalse(Prefs(activity).ageBlocked)
        assertNotNull(Prefs(activity).session)
        assertFalse(activity.isFinishing)
    }

    @Test
    fun `a minor arriving after sign-in has finished is still recorded and signed out`() {
        // finishSignIn writes the cookie and calls finish() on the same beat Play may
        // still be answering. Returning from blockForAge because the activity is
        // finishing would leave that cookie in place for the share sheet.
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        assertFalse(activity.enforceAgeGate { AgeGate(fake(result = range(13, 15))) })
        signedIn(activity)
        activity.finish()
        idle()
        val prefs = Prefs(activity)
        assertTrue(prefs.ageBlocked)
        assertNull(prefs.session)
        assertEquals(AgeBlockedActivity::class.java.name, shadowOf(activity).nextStartedActivity?.component?.className)
    }

    @Test
    fun `a sign-in that finishes after a block does not put the session back`() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        signedIn(activity)
        assertFalse(activity.enforceAgeGate { AgeGate(fake(result = range(13, 15))) })
        idle()
        val prefs = Prefs(activity)
        assertTrue(prefs.ageBlocked)
        assertNull(prefs.session)
        assertFalse(prefs.keepSignIn(SessionCookie("session", "token")))
        assertNull(prefs.session)
    }

    @Test
    fun `a sign-in is kept when the phone is not blocked`() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val prefs = Prefs(activity)
        assertTrue(prefs.keepSignIn(SessionCookie("session", "token")))
        assertNotNull(prefs.session)
    }

    @Test
    fun `a recorded block stops a share without copying the files`() {
        val seed = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        Prefs(seed).ageBlocked = true
        val intent = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "https://example.com")
        val share = Robolectric.buildActivity(ShareActivity::class.java, intent).setup().get()
        assertTrue(share.isFinishing)
        assertEquals(AgeBlockedActivity::class.java.name, shadowOf(share).nextStartedActivity?.component?.className)
    }

    @After
    fun restoreGate() {
        AgeBlockedActivity.gateFor = { AgeGate.forApp(it) }
    }

    private fun checkAgainWith(manager: FakeAgeSignalsManager): AgeBlockedActivity {
        AgeBlockedActivity.gateFor = { AgeGate(manager) }
        val activity = Robolectric.buildActivity(AgeBlockedActivity::class.java).setup().get()
        Prefs(activity).ageBlocked = true
        activity.checkAgain()
        idle()
        return activity
    }

    @Test
    fun `check again lifts the block only when Play says adult`() {
        val activity = checkAgainWith(fake(result = range(18, null)))
        assertFalse(Prefs(activity).ageBlocked)
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `check again with no answer from Play keeps the block`() {
        // Airplane mode answers Unknown too; a block a lost connection lifted would be none.
        val activity = checkAgainWith(fake(mandatory = false))
        assertTrue(Prefs(activity).ageBlocked)
        assertFalse(activity.isFinishing)
    }

    @Test
    fun `check again with a minor's answer keeps the block`() {
        val activity = checkAgainWith(fake(result = range(16, 17)))
        assertTrue(Prefs(activity).ageBlocked)
        assertFalse(activity.isFinishing)
    }
}
