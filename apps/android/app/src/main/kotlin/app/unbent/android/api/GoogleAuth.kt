package app.unbent.android.api

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
            .setAutoSelectEnabled(true)
            .build()

        /*
         * Answer from what is already on the device, rather than waiting on anything remote.
         *
         * Without this, a device with no Google account signed in does not refuse — it hangs.
         * Play Services accepts the request, never answers, and Credential Manager gives up
         * thirteen seconds later with a cancellation from the provider. Thirteen seconds of a
         * dead screen followed by a message reads as a broken app rather than a missing
         * account. With it the same device fails at once, and can say which it is.
         *
         * It costs nothing when an account is present: accounts on the device are exactly
         * what "immediately available" means, and the picker still appears.
         */
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .setPreferImmediatelyAvailableCredentials(true)
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
            val text = res.body?.string().orEmpty()
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
         * True when the device has no Google account to offer.
         *
         * Worth separating from every other failure because it is the only one the person
         * holding the phone can act on, and "add an account in Settings" is useless advice
         * for any of the others.
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
