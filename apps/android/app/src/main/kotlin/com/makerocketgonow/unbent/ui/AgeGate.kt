package com.makerocketgonow.unbent.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.tasks.Task
import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.AgeSignalsResult
import com.google.android.play.agesignals.ApplicableAgeFeaturesRequest
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import com.makerocketgonow.unbent.Prefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The youngest person the app serves. The terms say the same number, and the two must move
 * together: a gate that let a sixteen-year-old through terms that require eighteen would be
 * the app knowingly serving someone it had said it would not.
 *
 * Eighteen rather than COPPA's thirteen, deliberately. Unbent is a paid archive of
 * receipts and records, not something teenagers are its audience for, and a minor's
 * contract is voidable almost everywhere. Thirteen would still leave the duties some laws
 * add for people under eighteen (Brazil's Digital ECA asks for parental supervision tools,
 * and Texas-style app store laws for a parent's consent to changes), which an app with
 * no teenage audience has no reason to build.
 */
const val MINIMUM_AGE = 18

/** What Google Play says about the person on this phone, as far as the gate is concerned. */
enum class AgeVerdict {
    /** Play shared an age range that starts at [MINIMUM_AGE] or above. */
    Adult,

    /** Play shared an age range that ends below [MINIMUM_AGE]. */
    Minor,

    /**
     * Play said nothing the app may act on: no law has it share an age here, the person
     * declined or has not verified, the range straddles [MINIMUM_AGE], or Play could not
     * be asked at all (no Play Store, a sideloaded debug build, no network).
     */
    Unknown,
}

/**
 * Reads an age range. Ranges come in brackets (0 to 12, 13 to 15, 16 to 17, 18 and over,
 * with a null upper bound for the last), so in practice one is either wholly under
 * [MINIMUM_AGE] or wholly at or above it. A range that straddles it is [AgeVerdict.Unknown]
 * rather than a guess either way.
 */
internal fun verdictOf(result: AgeSignalsResult): AgeVerdict {
    val upper = result.ageUpper()
    val lower = result.ageLower()
    return when {
        upper != null && upper < MINIMUM_AGE -> AgeVerdict.Minor
        lower != null && lower >= MINIMUM_AGE -> AgeVerdict.Adult
        else -> AgeVerdict.Unknown
    }
}

/**
 * Asks Google Play's Age Signals API how old the person on this phone is, where a law makes
 * Play say (California and Brazil from January 2027, Texas now; see the store README).
 *
 * The law in California (AB 1043) has an app ask for the signal when it is opened, and
 * counts what comes back as the developer knowing the person's age. That knowledge is what
 * turns COPPA on for a general-audience app, so what Play says is acted on rather than
 * merely recorded: a [AgeVerdict.Minor] is signed out and kept out (see [enforceAgeGate]).
 *
 * Only where Play reports [ApplicableAgeFeature.MANDATORY_SHARING]. Elsewhere asking would
 * put Play's "share your age?" prompt in front of every adult in the world, for an answer
 * no law asks the app to have. The person is never asked their age by the app itself: a
 * date typed into a box tells the app nothing a child cannot lie about, and costs every
 * adult a step.
 *
 * Every failure is [AgeVerdict.Unknown], and the app opens. The gate exists to act on what
 * Play knows; when Play cannot be reached it knows nothing the app could act on, and an
 * archive that will not open in a tunnel, or on a phone without the Play Store, is a much
 * worse fault than the one this guards against. A [AgeVerdict.Minor] already recorded is
 * not lifted by a failure, only by Play saying [AgeVerdict.Adult] (`AgeBlockedActivity`).
 *
 * What Play returns is used for this decision and nothing else, which is also a condition
 * of the API's terms: it is not sent to the server, logged, or kept beyond the one flag.
 */
class AgeGate(private val manager: AgeSignalsManager) {

    suspend fun check(activity: Activity): AgeVerdict =
        try {
            ask(activity)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            AgeVerdict.Unknown
        }

    private suspend fun ask(activity: Activity): AgeVerdict {
        val features = manager.getApplicableAgeFeatures(ApplicableAgeFeaturesRequest.builder().build()).await()
        if (ApplicableAgeFeature.MANDATORY_SHARING !in features.features()) return AgeVerdict.Unknown

        /*
         * The activity lets Play draw its own prompt where one is due. In the US states that
         * verify ages there is no prompt: the answer is SHARED for someone verified or
         * supervised, and VERIFICATION_REQUIRED otherwise, which Play's docs say to answer
         * by sending the person to the Play Store. The app does not block on it. An adult
         * who has not verified with Play yet is the common case, and the law asks the app
         * to act on a signal, not to refuse everyone who has none.
         */
        val access = manager.requestAgeSignalsAccess(
            AgeSignalsAccessRequest.builder().setActivity(activity).build(),
        ).await()
        if (access.ageSignalsStatus() != AgeSignalsStatus.SHARED) return AgeVerdict.Unknown

        return verdictOf(manager.checkAgeSignals(AgeSignalsRequest.builder().build()).await())
    }

    companion object {
        fun forApp(context: Context) = AgeGate(AgeSignalsManagerFactory.create(context.applicationContext))
    }
}

/**
 * Keeps someone Play has said is under [MINIMUM_AGE] out of the app, from the activities a
 * person can open it by: the launcher's [MainActivity] and the deep-linked
 * [SignInActivity]. The share sheet needs a session, which a block clears.
 *
 * Two halves, because [MainActivity] needs them apart. [stopIfAgeBlocked] is synchronous and
 * comes first in `onCreate`, before anything else is decided. [checkAgeInBackground] asks
 * Play, and goes only where the activity is staying: a signed-out `MainActivity` hands
 * straight over to the sign-in screen and finishes, and a check started there would ask
 * Play to draw its prompt over an activity on its way out, only for the sign-in screen to
 * ask again. [enforceAgeGate] is both, for an activity with no such hand-over.
 *
 * The check runs beside whatever the activity draws, so an adult opening their notes waits
 * on nothing; a minor sees the app only for as long as Play takes to answer, once, before
 * the block is recorded and every later launch stops here.
 */
fun ComponentActivity.enforceAgeGate(gate: () -> AgeGate = { AgeGate.forApp(this) }): Boolean {
    if (stopIfAgeBlocked()) return true
    checkAgeInBackground(gate)
    return false
}

/**
 * Replaces the activity with the blocked screen when a block is already recorded. Returns
 * true when it did, so `onCreate` should stop.
 */
fun ComponentActivity.stopIfAgeBlocked(): Boolean {
    if (!Prefs(this).ageBlocked) return false
    startActivity(AgeBlockedActivity.intent(this))
    finish()
    return true
}

/** Asks Play, and blocks on a [AgeVerdict.Minor]. `gate` is a parameter so tests can hand in a fake. */
fun ComponentActivity.checkAgeInBackground(gate: () -> AgeGate = { AgeGate.forApp(this) }) {
    lifecycleScope.launch {
        if (gate().check(this@checkAgeInBackground) == AgeVerdict.Minor) blockForAge()
    }
}

/**
 * Records the block, signs out, and replaces everything on the back stack with the blocked
 * screen. The session goes so the share sheet, and a capture waiting in WorkManager, cannot
 * keep sending as the account behind the block.
 */
private fun Activity.blockForAge() {
    if (isFinishing) return
    val prefs = Prefs(this)
    prefs.ageBlocked = true
    prefs.clearSession()
    WebSession.clear()
    startActivity(AgeBlockedActivity.intent(this))
    finish()
}

/**
 * A Play Services [Task] as a suspend call, without a dependency for one function.
 *
 * A task Play cancelled is a failure, not a cancellation of the coroutine waiting on it.
 * Cancelling the continuation instead would throw a `CancellationException`, which
 * [AgeGate.check] rethrows on purpose, and the caller's coroutine would end in silence:
 * the blocked screen's button stayed disabled for good that way.
 */
private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { task ->
        val error = task.exception
        when {
            error != null -> cont.resumeWithException(error)
            task.isCanceled -> cont.resumeWithException(IllegalStateException("Play cancelled the age signals task"))
            else -> cont.resume(task.result)
        }
    }
}

/** Starts the activity as the only one in a fresh task: nothing to go Back to. */
internal fun Intent.clearingTask(): Intent =
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
