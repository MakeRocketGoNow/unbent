package com.makerocketgonow.unbent.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
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
 * No way in from here: no sign-in, no App settings, nothing that reaches an account. The
 * one action asks Play again, for the adult whose Play account had the wrong age (or a
 * parent's phone) and has since corrected it there. Only a definite [AgeVerdict.Adult]
 * lifts the block: [AgeVerdict.Unknown] is also what airplane mode answers, and a block
 * that a lost connection lifted would be no block at all.
 *
 * Its own activity rather than a state of [MainActivity], so that nothing of the WebView,
 * and therefore of the site and the notes it could still draw from the device, is ever
 * built behind it.
 */
class AgeBlockedActivity : ComponentActivity() {

    private var checking by mutableStateOf(false)
    private var stillBlocked by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            UnbentTheme {
                AgeBlocked(checking = checking, stillBlocked = stillBlocked, onCheck = ::checkAgain)
            }
        }
    }

    private fun checkAgain() {
        if (checking) return
        checking = true
        lifecycleScope.launch {
            val verdict = AgeGate.forApp(this@AgeBlockedActivity).check(this@AgeBlockedActivity)
            checking = false
            if (verdict == AgeVerdict.Adult) {
                Prefs(this@AgeBlockedActivity).ageBlocked = false
                startActivity(Intent(this@AgeBlockedActivity, MainActivity::class.java).clearingTask())
                finish()
            } else {
                stillBlocked = true
            }
        }
    }

    companion object {
        fun intent(context: Context): Intent =
            Intent(context, AgeBlockedActivity::class.java).clearingTask()
    }
}

@Composable
private fun AgeBlocked(checking: Boolean, stillBlocked: Boolean, onCheck: () -> Unit) {
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
                    if (stillBlocked) R.string.age_blocked_still else R.string.age_blocked_hint,
                    MINIMUM_AGE,
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Space.Small, bottom = Space.Screen),
            )
            Button(onClick = onCheck, enabled = !checking) {
                Text(stringResource(R.string.age_blocked_check))
            }
        }
    }
}
