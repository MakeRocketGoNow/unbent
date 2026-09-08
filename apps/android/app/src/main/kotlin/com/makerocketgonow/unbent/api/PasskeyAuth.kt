package com.makerocketgonow.unbent.api

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialException
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Signing in with a passkey, through Android's own credential sheet.
 *
 * The same WebAuthn credential the web app makes, reachable from here because the app and
 * the site are linked: `assetlinks.json` already declares this package for the Trusted Web
 * Activity, and passkeys reuse that exact association. Nothing new has to be hosted, but
 * that file is what makes this work — without it the sheet finds no credential for the
 * instance's domain and shows nothing.
 *
 * Two round trips, both to Better Auth's own endpoints: ask for a challenge, hand it to
 * Credential Manager, then post what the authenticator signed. The private key never
 * leaves the device, and this app never sees it either — it forwards an assertion.
 *
 * Unlike [GoogleAuth] this needs no client id, and unlike [ConnectAuth] it shows no web
 * page. It is the only method here that is both native and configuration-free.
 */
class PasskeyAuth(
    private val origin: String,
    private val client: OkHttpClient = UnbentApi.shared,
) {
    /**
     * Asks the server for a challenge, the sheet for a matching passkey, and the server to
     * verify what came back.
     *
     * The options are forwarded to Credential Manager verbatim rather than being parsed and
     * rebuilt: it takes the same JSON WebAuthn defines, so re-encoding it here would only
     * be an opportunity to drop a field the server cares about.
     */
    suspend fun signIn(context: Context): SessionCookie {
        val optionsJson = requestOptions()

        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetPublicKeyCredentialOption(optionsJson))
            .build()
        val response = CredentialManager.create(context).getCredential(context, request)

        val credential = response.credential as? PublicKeyCredential
            ?: throw ApiException(0, "Unexpected credential type from the passkey sheet.")

        return verify(credential.authenticationResponseJson)
    }

    /** The challenge. Public — it has to be, since asking for one precedes signing in. */
    private fun requestOptions(): String {
        val req = Request.Builder()
            .url("$origin/api/auth/passkey/generate-authenticate-options")
            .header("Origin", origin)
            .get()
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) {
                throw ApiException(res.code, "Could not start passkey sign-in: ${res.code}", text)
            }
            return text
        }
    }

    /**
     * Hands the signed assertion back for verification, and collects the session.
     *
     * The body is what the authenticator produced, forwarded unchanged for the same reason
     * the options were. A failure here is a real one — a credential the server does not
     * know, or a challenge that has expired — so the server's own words are worth keeping.
     */
    private fun verify(assertionJson: String): SessionCookie {
        val req = Request.Builder()
            .url("$origin/api/auth/passkey/verify-authentication")
            .header("Origin", origin)
            .post(assertionJson.toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) {
                throw ApiException(res.code, "Passkey sign-in failed: ${res.code}", text)
            }
            return SessionCookie.fromSetCookie(res.headers("Set-Cookie"))
                ?: throw ApiException(res.code, "Passkey sign-in returned no session.", text)
        }
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()

        /**
         * True when the user dismissed the sheet, or had no passkey to offer.
         *
         * Both are ordinary and neither is worth an error: someone who taps the button
         * without a passkey on this device should see the other methods still sitting
         * there, not a failure. Matched the same way [GoogleAuth] matches its cancellation.
         */
        fun wasCancelled(e: Throwable) = e is GetCredentialException &&
            (e.type.contains("USER_CANCELED", ignoreCase = true) ||
                e.type.contains("NO_CREDENTIAL", ignoreCase = true))
    }
}
