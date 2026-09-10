package com.makerocketgonow.unbent.api

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Signing in with Google through Android's own account sheet.
 *
 * This is the path that shows no web page at all: Credential Manager presents the accounts
 * already on the phone, the user taps one, and Google hands back a signed ID token which
 * the API verifies. It is what a native app does, and it is why Evernote never shows a
 * connect screen.
 *
 * Only Google. There is no system account picker for GitHub — an OAuth provider the phone
 * knows nothing about has to go through a browser — so [ConnectAuth] remains the fallback,
 * and the only path for anyone whose account is not a Google one.
 */
class GoogleAuth(
    private val origin: String,
    private val client: OkHttpClient = UnbentApi.shared,
) {
    /**
     * Asks Android for a Google ID token, then trades it for a session.
     *
     * `filterByAuthorizedAccounts = false` so an account that has never used this app still
     * appears; with it true, a first run shows an empty sheet and looks broken.
     */
    suspend fun signIn(context: Context, webClientId: String): SessionCookie {
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(webClientId)
            .setFilterByAuthorizedAccounts(false)
            /*
             * Auto-select only ever fires when exactly one account has already authorised
             * this app, so it cannot skip a choice the user still had to make — and on the
             * second sign-in it saves them making a choice of one.
             */
            .setAutoSelectEnabled(true)
            .build()

        /*
         * `preferImmediatelyAvailableCredentials` is deliberately left at its default of
         * false, and must stay there. It used to be set true, to make a phone with no Google
         * account fail at once rather than hang for thirteen seconds — but it bought that at
         * the cost of the feature working at all.
         *
         * The flag means, in the library's own words, "return immediately when there is no
         * available credentials instead of falling back to discovering remote options", and
         * androidx hands it straight to Play Services' BeginSignInRequest. Paired with
         * `filterByAuthorizedAccounts = false` above it is self-defeating: that asks for
         * accounts which have *not* yet authorised this app, which are precisely the ones
         * that are not sitting locally as an available credential. So Play Services took the
         * request, found nothing already available, and returned NO_CREDENTIAL instantly
         * without ever drawing the sheet — on phones signed into a Google account.
         *
         * That is indistinguishable from a phone with no account, which is why it read as a
         * signing or client-id problem for so long. If the thirteen-second hang comes back,
         * fix it with a timeout around this call, not by turning this on.
         */
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build()
        val response = CredentialManager.create(context).getCredential(context, request)

        val credential = response.credential
        val idToken = when {
            credential is androidx.credentials.CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL ->
                GoogleIdTokenCredential.createFrom(credential.data).idToken
            else -> throw ApiException(0, "Unexpected credential type from Google.")
        }

        /*
         * The account sheet has to run on the main thread — it is UI — but the exchange is
         * a blocking HTTP call, which Android refuses there. Only this half moves off.
         */
        return withContext(Dispatchers.IO) { exchange(idToken) }
    }

    /**
     * Hands the Google ID token to Better Auth, which verifies its signature and audience
     * and signs the app in. The same endpoint the web app's Google button uses.
     */
    private fun exchange(idToken: String): SessionCookie {
        val payload = JSONObject()
            .put("provider", "google")
            .put("idToken", JSONObject().put("token", idToken))
            .toString()

        val req = Request.Builder()
            .url("$origin/api/auth/sign-in/social")
            // Better Auth enforces CSRF by requiring a trusted Origin.
            .header("Origin", origin)
            .post(payload.toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) {
                throw ApiException(res.code, "Google sign-in failed: ${res.code}", text)
            }
            // The credential is the cookie the response set, not the token in its body: see
            // SessionCookie for why one string has to serve both OkHttp and the WebView.
            return SessionCookie.fromSetCookie(res.headers("Set-Cookie"))
                ?: throw ApiException(res.code, "Google sign-in returned no session.")
        }
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()

        /** Whether a build was given a client id, and can therefore offer this at all. */
        fun isConfigured(webClientId: String) = webClientId.isNotEmpty()

            /** True when the user dismissed the sheet, which is a choice rather than a failure. */
        fun wasCancelled(e: Throwable) =
            e is GetCredentialException && e.type.contains("USER_CANCELED", ignoreCase = true)

        /**
         * True when Google had no credential to offer.
         *
         * Not the same as "the device has no Google account", though that is one cause.
         * Google answers NO_CREDENTIAL for anything that leaves it unwilling to produce a
         * token, and the causes that are ours look identical from here: a request that asked
         * for immediately-available credentials only (see [signIn], which is what this app
         * actually got wrong), or a signing certificate the OAuth client does not know, which
         * is every Play-signed build until the App Signing key's SHA-1 is registered.
         *
         * So the wording this maps to suggests checking Settings rather than asserting what
         * is on the phone. When a report says the message appeared on a phone that plainly
         * has an account, suspect this side of it before the phone.
         *
         * Matched on the type string as well as the class: the framework reports this as a
         * plain GetCredentialException carrying TYPE_NO_CREDENTIAL in some paths rather than
         * as the typed subclass, and both mean the same thing here.
         */
        fun hasNoAccount(e: Throwable) =
            e is NoCredentialException ||
                (e is GetCredentialException && e.type.contains("NO_CREDENTIAL", ignoreCase = true))
    }
}
