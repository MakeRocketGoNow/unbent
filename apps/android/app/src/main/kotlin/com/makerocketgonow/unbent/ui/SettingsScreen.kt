package com.makerocketgonow.unbent.ui

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.makerocketgonow.unbent.BuildConfig
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.Prefs
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Who is signed in, where, and the way out.
 *
 * Deliberately short. Notebooks and the trash have screens of their own now, reached from
 * the drawer; import and export stay on the site and are one tap away. The address field
 * exists because an emulator has to be pointed at a dev server, and a self-hoster at their
 * own instance.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    api: UnbentApi,
    prefs: Prefs,
    onBack: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf<String?>(null) }
    var address by rememberSaveable { mutableStateOf(prefs.instance) }

    LaunchedEffect(api) {
        withContext(Dispatchers.IO) { runCatching { api.me() } }.onSuccess { email = it?.email }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
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
            Text(
                stringResource(R.string.signed_in_as),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(email ?: "…", style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.height(Space.Medium))
            OutlinedButton(
                onClick = {
                    scope.launch {
                        // Revoke on the server when it can be reached; leave regardless.
                        withContext(Dispatchers.IO) { api.signOut() }
                        onSignedOut()
                    }
                },
            ) { Text(stringResource(R.string.sign_out)) }

            HorizontalDivider(Modifier.padding(vertical = Space.Screen))

            Text(
                stringResource(R.string.instance_label),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(Space.Small))
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(Space.Small))
            val normalized = Prefs.normalizeOrigin(address)
            Button(
                onClick = {
                    /*
                     * A different instance is a different account, so this goes through
                     * sign-in. The session for the old address stays stored under it, and
                     * pointing back finds it again.
                     */
                    prefs.instance = normalized
                    onSignedOut()
                },
                enabled = normalized.isNotEmpty() && normalized != prefs.instance,
            ) { Text(stringResource(R.string.instance_use)) }

            HorizontalDivider(Modifier.padding(vertical = Space.Screen))

            OutlinedButton(
                onClick = {
                    runCatching {
                        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(prefs.instance))
                    }
                },
            ) { Text(stringResource(R.string.manage_on_web)) }
            Spacer(Modifier.height(Space.Small))
            Text(
                stringResource(R.string.manage_on_web_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            HorizontalDivider(Modifier.padding(vertical = Space.Screen))

            /*
             * Deleting the account, which Play requires be reachable from inside the app
             * rather than only by writing in.
             *
             * It opens the instance's Maintenance settings rather than deleting from here.
             * That is where the flow starts: the site emails a confirmation link and
             * deletes nothing until it is opened, so a native copy would be a second
             * confirmation UI in front of the one that actually decides — for something a
             * person does once, if ever. The Custom Tab carries the browser's session, not
             * this app's, so whoever follows it signs in there the same way "Manage on the
             * web" above already expects.
             */
            OutlinedButton(
                onClick = {
                    runCatching {
                        CustomTabsIntent.Builder().build().launchUrl(
                            context,
                            Uri.parse(Prefs.deleteAccountUrl(prefs.instance)),
                        )
                    }
                },
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) { Text(stringResource(R.string.delete_account)) }
            Spacer(Modifier.height(Space.Small))
            Text(
                stringResource(R.string.delete_account_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            /*
             * Which build this is, at the bottom where an about line belongs.
             *
             * Both numbers, because neither is enough alone: `versionName` stays the same
             * across every build until someone bumps it, and `versionCode` is the one that
             * rises every build but is shown nowhere else on Android. A tester asked which build
             * they are on had no way to answer before this.
             */
            Spacer(Modifier.height(Space.Large))
            Text(
                stringResource(
                    R.string.settings_version,
                    BuildConfig.VERSION_NAME,
                    BuildConfig.VERSION_CODE,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
