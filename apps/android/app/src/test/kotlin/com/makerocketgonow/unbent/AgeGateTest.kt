package com.makerocketgonow.unbent

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
import com.makerocketgonow.unbent.ui.AgeGate
import com.makerocketgonow.unbent.ui.AgeVerdict
import com.makerocketgonow.unbent.ui.verdictOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
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
}
