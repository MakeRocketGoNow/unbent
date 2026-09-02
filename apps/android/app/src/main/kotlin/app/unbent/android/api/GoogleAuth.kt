package app.unbent.android.api

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
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

        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
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
                throw ApiException(res.code, "Google sign-in failed: ${res.code} ${text.take(200)}")
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
    }
}
