package com.makerocketgonow.unbent.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import com.makerocketgonow.unbent.BuildConfig
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.ui.theme.Space
import com.makerocketgonow.unbent.ui.theme.UnbentTheme

/**
 * The app's own settings: which Unbent it opens, and which build it is.
 *
 * Everything else a person configures lives on the site, which the app hosts whole:
 * notebooks, tags, import and export, security, deleting the account. What stays here is
 * what the site cannot know or change: the address the app points its WebView at is the
 * app's, and so is its version.
 *
 * An activity of its own rather than a page drawn over the WebView, so the WebView behind
 * it is untouched on the way back: its scroll, an open note, an upload in flight. Reached
 * from the site's Settings (the "App settings" pill posts `app-settings` over the bridge)
 * and from the launcher's long-press shortcut, which goes through [MainActivity] because
 * that one is exported and this need not be.
 */
class AppSettingsActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val prefs = Prefs(this)
        setContent {
            UnbentTheme {
                AppSettings(
                    current = prefs.instance,
                    onUse = { use(prefs, it) },
                    onBack = ::finish,
                )
            }
        }
    }

    /**
     * Points the app at another instance and starts it over there.
     *
     * The session for the old address stays stored under that address, so pointing back
     * finds it again and nobody has to sign in twice to move between a laptop's dev server
     * and the real one. The previous screen promised exactly that in a comment and then
     * cleared the *new* address's session on its way out, which kept the promise for no one.
     *
     * The WebView's cookie jar is emptied, because it would otherwise hold the old site's
     * cookies alongside the new; the app writes the right session into it again before the
     * next load. The task is cleared and started fresh because everything in it (the page,
     * its history, the address it loaded) belongs to the instance being left.
     */
    private fun use(prefs: Prefs, address: String) {
        WebSession.clear()
        prefs.instance = address
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
        )
        finish()
    }

    companion object {
        fun intent(context: Context): Intent = Intent(context, AppSettingsActivity::class.java)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
private fun AppSettings(current: String, onUse: (String) -> Unit, onBack: () -> Unit) {
    var address by rememberSaveable { mutableStateOf(current) }
    val normalized = Prefs.normalizeOrigin(address)
    val changed = normalized.isNotEmpty() && normalized != current

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(Space.Screen),
        ) {
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                label = { Text(stringResource(R.string.instance_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (changed) onUse(normalized) }),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(Space.Small))
            Text(
                stringResource(R.string.instance_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(Space.Medium))
            // Only once there is somewhere different to go: a button that reloads the same
            // instance would look like it did something and do nothing.
            Button(onClick = { onUse(normalized) }, enabled = changed) {
                Text(stringResource(R.string.instance_use))
            }

            /*
             * Which build this is, at the bottom where an about line belongs.
             *
             * Both numbers, because neither is enough alone: `versionName` stays the same
             * across every build until someone bumps it, and `versionCode` is the one that
             * rises every build but is shown nowhere else on Android. A tester asked which
             * build they are on had no way to answer before this.
             */
            Spacer(Modifier.height(Space.Large))
            Text(
                stringResource(R.string.settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
