package com.makerocketgonow.unbent.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.ui.theme.Space
import com.makerocketgonow.unbent.ui.theme.UnbentTheme
import kotlinx.coroutines.launch

/**
 * What someone Google Play has said is under [MINIMUM_AGE] sees instead of the app, every
 * time they open it, until Play says otherwise.
 *
 * No way in from here: no sign-in, no App settings, nothing that reaches an account. Two
 * actions. "Check again" asks Play again, for the adult whose Play account had the wrong
 * age (or a parent's phone) and has since corrected it there. "How to delete my account" opens
 * the instance's own deletion page in a browser, which is the existing flow (an emailed
 * link, or a message to the operator for someone who cannot sign in) rather than a second
 * one: the block already took the app's session, and an account is deleted by its owner
 * confirming it, never because Play's answer said so. Only a definite [AgeVerdict.Adult]
 * lifts the block: [AgeVerdict.Unknown] is also what airplane mode answers, and a block
 * that a lost connection lifted would be no block at all.
 *
 * Its own activity rather than a state of [MainActivity], so that nothing of the WebView,
 * and therefore of the site and the notes it could still draw from the device, is ever
 * built behind it.
 */
class AgeBlockedActivity : ComponentActivity() {

    private var checking by mutableStateOf(false)
    /**
     * What the last press of Check again heard, to say which it was: Play answering under
     * [MINIMUM_AGE] is not Play being out of reach, and telling someone in a tunnel that
     * Play still disagrees sends them to correct an age that may already be right.
     */
    private var lastVerdict by mutableStateOf<AgeVerdict?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            UnbentTheme {
                AgeBlocked(
                    checking = checking,
                    lastVerdict = lastVerdict,
                    onCheck = ::checkAgain,
                    onDelete = ::openDeletion,
                )
            }
        }
    }

    /** The page that says how to delete an account, on the instance the app points at. */
    private fun openDeletion() {
        openOutside(this, Destination.Browser(Prefs(this).instance + DELETION_PATH))
    }

    private fun checkAgain() {
        if (checking) return
        checking = true
        lifecycleScope.launch {
            val verdict = try {
                AgeGate.forApp(this@AgeBlockedActivity).check(this@AgeBlockedActivity)
            } finally {
                checking = false
            }
            if (verdict == AgeVerdict.Adult) {
                Prefs(this@AgeBlockedActivity).ageBlocked = false
                startActivity(Intent(this@AgeBlockedActivity, MainActivity::class.java).clearingTask())
                finish()
            } else {
                lastVerdict = verdict
            }
        }
    }

    companion object {
        /** The web app's `HOW_TO_DELETE`, the address Play Console's deletion URL names too. */
        private const val DELETION_PATH = "/delete-my-account"

        fun intent(context: Context): Intent =
            Intent(context, AgeBlockedActivity::class.java).clearingTask()
    }
}

@Composable
private fun AgeBlocked(checking: Boolean, lastVerdict: AgeVerdict?, onCheck: () -> Unit, onDelete: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(Space.Screen),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                stringResource(R.string.age_blocked_title),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            Text(
                stringResource(R.string.age_blocked_body, MINIMUM_AGE),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Space.Small),
            )
            Text(
                stringResource(
                    when (lastVerdict) {
                        AgeVerdict.Minor -> R.string.age_blocked_still
                        AgeVerdict.Unknown -> R.string.age_blocked_no_answer
                        else -> R.string.age_blocked_hint
                    },
                    MINIMUM_AGE,
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Space.Small, bottom = Space.Screen),
            )
            // The same pair as the unreachable panel: the way out quiet, the retry filled.
            Row(horizontalArrangement = Arrangement.spacedBy(Space.Small)) {
                TextButton(onClick = onDelete) { Text(stringResource(R.string.age_blocked_delete)) }
                Button(onClick = onCheck, enabled = !checking) {
                    // Three calls to Play in a row can take a few seconds, and a faded button
                    // alone reads as broken. The label stays, unseen, so the button keeps its
                    // width and the quiet action beside it does not move.
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            stringResource(R.string.age_blocked_check),
                            Modifier.alpha(if (checking) 0f else 1f),
                        )
                        if (checking) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
    }
}
