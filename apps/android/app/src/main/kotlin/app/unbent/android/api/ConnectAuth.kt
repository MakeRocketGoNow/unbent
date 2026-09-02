package app.unbent.android.api

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Trading a one-time token for a session.
 *
 * The other half of /connect. The phone opens that page in a Custom Tab, where the browser
 * is already signed in — by whichever provider the user chose, which is the point: Google,
 * GitHub, and anything added later all work without this file knowing they exist. The page
 * mints a token, redirects into the app, and this exchanges it for an ordinary session.
 *
 * Preferred over the device-code flow because there is nothing for the user to read or
 * type. That flow remains for the CLI, which has no browser to redirect back from.
 */
class ConnectAuth(
    private val origin: String,
    private val client: OkHttpClient = UnbentApi.shared,
) {
    /** The page to open. `redirect` is where the browser hands the token back. */
    fun connectUrl(scheme: String): String =
        "$origin/connect?redirect=${java.net.URLEncoder.encode("$scheme://connect", "UTF-8")}"

    /**
     * Exchanges the token for a session token usable as a bearer credential.
     *
     * The one-time token is spent by this call — replaying it fails — so a session that
     * does not get stored is simply lost, and the user connects again.
     */
    fun redeem(token: String): String {
        val req = Request.Builder()
            .url("$origin/api/auth/one-time-token/verify")
            // Better Auth enforces CSRF by requiring a trusted Origin.
            .header("Origin", origin)
            .post(JSONObject().put("token", token).toString().toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw ApiException(res.code, "Could not connect: ${res.code} ${text.take(200)}")
            }
            val session = JSONObject(text).optJSONObject("session")
                ?: throw ApiException(res.code, "Unexpected response while connecting.")
            return session.optString("token").ifEmpty {
                throw ApiException(res.code, "Unexpected response while connecting.")
            }
        }
    }

    /**
     * Mints a one-time token from this app's session, for handing to the browser.
     *
     * The reverse of [redeem]: there, a browser session becomes an app session; here, the
     * app's session becomes a browser one. Needed because the app can now sign in without a
     * browser at all — Android's account sheet — which leaves the browser it opens logged
     * out, showing a sign-in page to a user who just signed in.
     */
    fun mintHandoffToken(sessionToken: String): String? {
        val req = Request.Builder()
            .url("$origin/api/auth/one-time-token/generate")
            .header("Origin", origin)
            .header("Authorization", "Bearer $sessionToken")
            .get()
            .build()

        return runCatching {
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use null
                JSONObject(res.body?.string().orEmpty()).optString("token").ifEmpty { null }
            }
        }.getOrNull()
    }

    /** The URL that signs the browser in and then lands on [path]. */
    fun handoffUrl(token: String, path: String): String {
        val t = java.net.URLEncoder.encode(token, "UTF-8")
        val p = java.net.URLEncoder.encode(path, "UTF-8")
        return "$origin/handoff?token=$t&next=$p"
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()
    }
}
