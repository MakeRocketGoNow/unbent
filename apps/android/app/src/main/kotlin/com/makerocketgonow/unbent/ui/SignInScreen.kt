package com.makerocketgonow.unbent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.AppConfig
import com.makerocketgonow.unbent.ui.theme.Space

/**
 * The sign-in screen, drawn from what the instance says it offers.
 *
 * The same shape as the web app's login: a button per provider, then a password form when
 * the instance has one, with a divider between the two kinds. Which of those appear is the
 * instance's decision (`/api/config`), not this screen's: unbent.app shows the providers,
 * a self-hosted instance typically shows the form.
 *
 * The instance address sits at the bottom because it has to be reachable before anything
 * else works (a self-hoster's first act is pointing the app at their server) but it is
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
    onBrowserSocial: () -> Unit,
    onPasskey: () -> Unit,
    /** Sends a code, then signs in with it. Null code means "send one to this address". */
    onEmailOtp: (email: String, code: String?) -> Unit,
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
                .padding(Space.Screen),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(Space.Small))
            Text(
                stringResource(R.string.sign_in_intro),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(Space.Screen))

            when {
                configError != null -> {
                    Text(configError, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(Space.Medium))
                    OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
                }
                config == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                else -> Methods(config, busy, onGoogle, onBrowserSocial, onPasskey, onEmailOtp, onPassword)
            }

            if (status != null) {
                Spacer(Modifier.height(Space.Screen))
                Text(
                    status,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(Space.Screen))
            InstanceLine(instance, enabled = !busy, onChange = onInstanceChange)
        }
    }
}

@Composable
private fun Methods(
    config: AppConfig,
    busy: Boolean,
    onGoogle: () -> Unit,
    onBrowserSocial: () -> Unit,
    onPasskey: () -> Unit,
    onEmailOtp: (String, String?) -> Unit,
    onPassword: (String, String, String?) -> Unit,
) {
    // 48dp is Material's minimum touch target, not a spacing step: it stays a literal
    // rather than coming from Space, which measures gaps between things.
    val button = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    val hasSocial = config.google || config.browserSocials > 0
    val hasEmail = config.emailOtp || config.password

    /*
     * The methods on offer, in the order they are shown, with the dividers left to the loop
     * below, the same arrangement and the same order as the web sign-in screen, which is
     * the point: the two are the same product and someone moving between them should not
     * have to look for the button twice.
     *
     * Social leads because it is one tap and needs nothing typed. Passkeys are faster
     * still, but only for someone who already has one, which is nobody arriving for the
     * first time. Anything beginning with an address comes last.
     *
     * A list rather than a run of `if` blocks each working out whether anything preceded
     * it: that put the order in several boolean chains that all had to agree, so moving one
     * method meant editing every one of them.
     */
    val sections = buildList<@Composable () -> Unit> {
        if (hasSocial) add {
            Column {
                /*
                 * Providers are outlined and equal: filling one would say the app prefers
                 * it, and it does not. The email form's own submit is the filled button,
                 * because there it is the one thing the form is for.
                 */
                if (config.google) {
                    OutlinedButton(onClick = onGoogle, enabled = !busy, modifier = button) {
                        Icon(
                            painterResource(R.drawable.ic_google),
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = Color.Unspecified,
                        )
                        Spacer(Modifier.width(Space.Small))
                        Text(stringResource(R.string.sign_in_google))
                    }
                }
                if (config.browserSocials > 0) {
                    if (config.google) Spacer(Modifier.height(Space.Medium))
                    OutlinedButton(onClick = onBrowserSocial, enabled = !busy, modifier = button) {
                        Text(stringResource(R.string.sign_in_browser_social))
                    }
                }
            }
        }
        if (config.passkey) add {
            OutlinedButton(onClick = onPasskey, enabled = !busy, modifier = button) {
                Text(stringResource(R.string.sign_in_passkey))
            }
        }
        if (hasEmail) add {
            EmailForm(
                otp = config.emailOtp,
                password = config.password,
                busy = busy,
                onEmailOtp = onEmailOtp,
                onPassword = onPassword,
            )
        }
    }

    sections.forEachIndexed { index, section ->
        if (index > 0) {
            Spacer(Modifier.height(Space.Large))
            OrDivider()
            Spacer(Modifier.height(Space.Large))
        }
        section()
    }

    if (sections.isEmpty()) {
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
            modifier = Modifier.padding(horizontal = Space.Medium),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f))
    }
}

/**
 * Everything that starts with an email address, in one form.
 *
 * The two email methods were separate forms rendered one after the other, which on an
 * instance offering both produced two address boxes a divider apart: the same question
 * asked twice, with nothing on screen saying so. The web screen had the same fault and was
 * fixed the same way, which matters because these two are the same product.
 *
 * The address is asked once and the ways to proceed hang off it: a password box and Sign in
 * where passwords are on, "Email me a code" where codes are on, both where both are.
 *
 * The password is the primary action when both exist, and the code button goes quiet beside
 * it: someone who has a password is signing in with it, and the code is for having
 * forgotten it or never set one. Two filled buttons would be a choice with no default.
 *
 * `rememberSaveable` throughout, so turning the phone while reading a code out of a mail
 * app does not throw away the address or the step already taken.
 */
@Composable
private fun EmailForm(
    otp: Boolean,
    password: Boolean,
    busy: Boolean,
    onEmailOtp: (String, String?) -> Unit,
    onPassword: (String, String, String?) -> Unit,
) {
    var creating by rememberSaveable { mutableStateOf(false) }
    var email by rememberSaveable { mutableStateOf("") }
    var secret by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var codeSent by rememberSaveable { mutableStateOf(false) }
    var code by rememberSaveable { mutableStateOf("") }

    val button = Modifier.fillMaxWidth().heightIn(min = 48.dp)
    val canSignIn = !busy && email.isNotBlank() && secret.length >= 8
    val canSendCode = !busy && email.isNotBlank()

    fun submitPassword() = onPassword(email.trim(), secret, if (creating) name.trim() else null)
    fun sendCode() {
        onEmailOtp(email.trim(), null)
        codeSent = true
    }

    /* The code step replaces the form: there is nothing else to do until it is entered. */
    if (codeSent) {
        Column {
            Text(
                stringResource(R.string.sign_in_otp_sent, email.trim()),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(Space.Medium))
            OutlinedTextField(
                value = code,
                // Digits only, so a code pasted with a stray space still submits.
                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                label = { Text(stringResource(R.string.sign_in_otp_code)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.NumberPassword,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(
                    onDone = { if (!busy && code.length == 6) onEmailOtp(email.trim(), code) },
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(Space.Large))
            Button(
                onClick = { onEmailOtp(email.trim(), code) },
                enabled = !busy && code.length == 6,
                modifier = button,
            ) {
                Text(stringResource(R.string.sign_in_submit))
            }
            TextButton(
                onClick = {
                    // Back to the address, so a typo is fixable without starting over.
                    codeSent = false
                    code = ""
                },
                enabled = !busy,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            ) {
                Text(stringResource(R.string.sign_in_otp_other_address))
            }
        }
        return
    }

    Column {
        if (password && creating) {
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
            Spacer(Modifier.height(Space.Medium))
        }

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(stringResource(R.string.sign_in_email)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                autoCorrectEnabled = false,
                imeAction = if (password) ImeAction.Next else ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(
                onDone = { if (!password && canSendCode) sendCode() },
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        if (password) {
            Spacer(Modifier.height(Space.Medium))
            OutlinedTextField(
                value = secret,
                onValueChange = { secret = it },
                label = { Text(stringResource(R.string.sign_in_password)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { if (canSignIn) submitPassword() }),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(Space.Large))
            Button(onClick = ::submitPassword, enabled = canSignIn, modifier = button) {
                Text(
                    stringResource(
                        if (creating) R.string.sign_up_submit else R.string.sign_in_submit,
                    ),
                )
            }
        }

        if (otp) {
            Spacer(Modifier.height(if (password) Space.Medium else Space.Large))
            if (password) {
                // Beside a password this is the alternative, so it is outlined rather than
                // filled; alone it is the only way forward and takes the filled treatment.
                OutlinedButton(onClick = ::sendCode, enabled = canSendCode, modifier = button) {
                    Text(stringResource(R.string.sign_in_otp_send))
                }
            } else {
                Button(onClick = ::sendCode, enabled = canSendCode, modifier = button) {
                    Text(stringResource(R.string.sign_in_otp_send))
                }
            }
        }

        if (password) {
            TextButton(
                onClick = { creating = !creating },
                enabled = !busy,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            ) {
                Text(
                    stringResource(
                        if (creating) R.string.sign_in_switch_in else R.string.sign_in_switch_up,
                    ),
                )
            }
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
    Spacer(Modifier.height(Space.Small))
    Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
        TextButton(onClick = { draft = instance; editing = false }) {
            Text(stringResource(R.string.cancel))
        }
        Button(onClick = { onChange(draft); editing = false }, enabled = draft.isNotBlank()) {
            Text(stringResource(R.string.instance_use))
        }
    }
}
