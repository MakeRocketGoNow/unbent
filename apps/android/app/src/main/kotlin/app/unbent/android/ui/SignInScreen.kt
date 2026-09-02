package app.unbent.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.unbent.android.R
import app.unbent.android.api.AppConfig

/**
 * The sign-in screen, drawn from what the instance says it offers.
 *
 * The same shape as the web app's login: a button per provider, then a password form when
 * the instance has one, with a divider between the two kinds. Which of those appear is the
 * instance's decision (`/api/config`), not this screen's — unbent.app shows the providers,
 * a self-hosted instance typically shows the form.
 *
 * The instance address sits at the bottom because it has to be reachable before anything
 * else works — a self-hoster's first act is pointing the app at their server — but it is
 * a rare act, so it reads as a line of status with a way to change it rather than a field.
 */
@Composable
fun SignInScreen(
    instance: String,
    config: AppConfig?,
    configError: String?,
    status: String?,
    busy: Boolean,
    onGoogle: () -> Unit,
    onGitHub: () -> Unit,
    /** Name is null to sign in and present (possibly blank) to create an account. */
    onPassword: (email: String, password: String, name: String?) -> Unit,
    onInstanceChange: (String) -> Unit,
    onRetry: () -> Unit,
) {
    Scaffold { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.sign_in_intro),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(32.dp))

            when {
                configError != null -> {
                    Text(configError, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
                }
                config == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                else -> Methods(config, busy, onGoogle, onGitHub, onPassword)
            }

            if (status != null) {
                Spacer(Modifier.height(24.dp))
                Text(
                    status,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(32.dp))
            InstanceLine(instance, enabled = !busy, onChange = onInstanceChange)
        }
    }
}

@Composable
private fun Methods(
    config: AppConfig,
    busy: Boolean,
    onGoogle: () -> Unit,
    onGitHub: () -> Unit,
    onPassword: (String, String, String?) -> Unit,
) {
    val social = config.google || config.github
    val button = Modifier.fillMaxWidth().heightIn(min = 48.dp)

    /*
     * Providers are outlined and equal, as on the web: filling one would say the app
     * prefers it, and it does not. The password form's own submit is the filled button,
     * because there it is the one thing the form is for.
     */
    if (config.google) {
        OutlinedButton(onClick = onGoogle, enabled = !busy, modifier = button) {
            Text(stringResource(R.string.sign_in_google))
        }
    }
    if (config.github) {
        if (config.google) Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onGitHub, enabled = !busy, modifier = button) {
            Text(stringResource(R.string.sign_in_github))
        }
    }

    if (config.password) {
        if (social) {
            Spacer(Modifier.height(20.dp))
            OrDivider()
            Spacer(Modifier.height(20.dp))
        }
        PasswordForm(busy, onPassword)
    }

    if (!social && !config.password) {
        Text(
            stringResource(R.string.sign_in_none),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** "or" between the providers and the form, so the two do not read as one list. */
@Composable
private fun OrDivider() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f))
        Text(
            stringResource(R.string.sign_in_or),
            modifier = Modifier.padding(horizontal = 12.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f))
    }
}

/**
 * Email and password, with a toggle to create an account instead.
 *
 * A name field appears only for sign-up, where Better Auth requires one; asking for it on
 * every sign-in would be a field the returning user has to skip past. Submit enables once
 * the password reaches Better Auth's minimum, so the server never has to say so.
 */
@Composable
private fun PasswordForm(busy: Boolean, onSubmit: (String, String, String?) -> Unit) {
    var creating by rememberSaveable { mutableStateOf(false) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }

    val canSubmit = !busy && email.isNotBlank() && password.length >= 8
    fun submit() = onSubmit(email.trim(), password, if (creating) name.trim() else null)

    Column {
        if (creating) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.sign_in_name)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Words,
                    imeAction = ImeAction.Next,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
        }
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(stringResource(R.string.sign_in_email)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Next,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(stringResource(R.string.sign_in_password)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { if (canSubmit) submit() }),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = ::submit,
            enabled = canSubmit,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) {
            Text(stringResource(if (creating) R.string.sign_up_submit else R.string.sign_in_submit))
        }
        TextButton(
            onClick = { creating = !creating },
            enabled = !busy,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        ) {
            Text(stringResource(if (creating) R.string.sign_in_switch_in else R.string.sign_in_switch_up))
        }
    }
}

/**
 * Which Unbent this is signing in to, and a way to change it.
 *
 * A line with a Change control rather than an always-present field. Almost everyone signs
 * in to the one instance the app was built for; the field exists for self-hosters, and
 * an editable address on every sign-in screen invites the rest to wonder what to type.
 */
@Composable
private fun InstanceLine(instance: String, enabled: Boolean, onChange: (String) -> Unit) {
    var editing by rememberSaveable { mutableStateOf(false) }
    var draft by rememberSaveable(instance) { mutableStateOf(instance) }

    if (!editing) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.sign_in_instance, instance.removePrefix("https://")),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = { editing = true }, enabled = enabled) {
                Text(stringResource(R.string.change))
            }
        }
        return
    }

    OutlinedTextField(
        value = draft,
        onValueChange = { draft = it },
        label = { Text(stringResource(R.string.instance_label)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onChange(draft); editing = false }),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
        TextButton(onClick = { draft = instance; editing = false }) {
            Text(stringResource(R.string.cancel))
        }
        Button(onClick = { onChange(draft); editing = false }, enabled = draft.isNotBlank()) {
            Text(stringResource(R.string.instance_use))
        }
    }
}
