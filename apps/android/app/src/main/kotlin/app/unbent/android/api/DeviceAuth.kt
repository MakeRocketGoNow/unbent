package app.unbent.android.api

import java.io.IOException
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** What the server hands back when a flow starts. */
data class DeviceCodeGrant(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String?,
    val expiresInSeconds: Long,
    val intervalSeconds: Long,
)

/** Why a sign-in stopped, so the UI can say something specific. */
sealed class SignInResult {
    data class Success(val token: String) : SignInResult()
    object Denied : SignInResult()
    object Expired : SignInResult()
    data class Failed(val message: String) : SignInResult()
}

/**
 * Signing this phone in without it ever handling a password.
 *
 * The device flow (RFC 8628): ask for a code, send the user to a browser already signed in
 * to Unbent, and poll until they approve. A port of packages/migrate/src/auth.ts, and it
 * inherits that file's two hard-won details — the endpoint wants JSON rather than the form
 * encoding the RFC specifies, and a `slow_down` must raise the interval permanently rather
 * than for one sleep.
 */
class DeviceAuth(
    private val origin: String,
    private val client: OkHttpClient = UnbentApi.shared,
) {
    fun requestCode(): DeviceCodeGrant {
        val body = post("/api/auth/device/code", JSONObject().put("client_id", CLIENT_ID))
        return DeviceCodeGrant(
            deviceCode = body.getString("device_code"),
            userCode = body.getString("user_code"),
            verificationUri = body.optString("verification_uri", "$origin/device"),
            verificationUriComplete = body.optString("verification_uri_complete").ifEmpty { null },
            expiresInSeconds = body.optLong("expires_in", 1800L),
            intervalSeconds = body.optLong("interval", 5L),
        )
    }

    /**
     * Polls until the user decides.
     *
     * `sleep` and `now` are injected so a test can drive the whole loop without waiting
     * through real five-second backoffs — the same reason the CLI's version takes a sleep.
     */
    fun awaitToken(
        grant: DeviceCodeGrant,
        isCancelled: () -> Boolean = { false },
        now: () -> Long = System::currentTimeMillis,
        sleep: (Long) -> Unit = Thread::sleep,
    ): SignInResult {
        val deadline = now() + grant.expiresInSeconds * 1000
        var interval = maxOf(1L, grant.intervalSeconds) * 1000

        while (true) {
            if (isCancelled()) return SignInResult.Failed("Sign-in cancelled.")
            if (now() > deadline) return SignInResult.Expired

            sleep(interval)
            if (isCancelled()) return SignInResult.Failed("Sign-in cancelled.")

            val body = try {
                post(
                    "/api/auth/device/token",
                    JSONObject()
                        .put("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
                        .put("device_code", grant.deviceCode)
                        .put("client_id", CLIENT_ID),
                )
            } catch (e: IOException) {
                // A dropped radio mid-poll is ordinary on a phone; keep waiting rather than
                // failing a sign-in the user is in the middle of approving.
                continue
            }

            if (body.has("access_token")) return SignInResult.Success(body.getString("access_token"))

            when (body.optString("error")) {
                "authorization_pending" -> continue
                "slow_down" -> interval += 5000
                "access_denied" -> return SignInResult.Denied
                "expired_token" -> return SignInResult.Expired
                "" -> return SignInResult.Failed("Unexpected response from Unbent.")
                else -> return SignInResult.Failed(
                    body.optString("error_description").ifEmpty { body.optString("error") },
                )
            }
        }
    }

    /** The page the user approves on, pre-filled with the code when the server offers it. */
    fun approvalUrl(grant: DeviceCodeGrant): String =
        grant.verificationUriComplete ?: "$origin/device?user_code=${grant.userCode}"

    private fun post(path: String, payload: JSONObject): JSONObject {
        val req = Request.Builder()
            .url("$origin$path")
            // Better Auth enforces CSRF by requiring a trusted Origin on every request.
            .header("Origin", origin)
            .post(payload.toString().toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val parsed = try {
                JSONObject(text)
            } catch (_: Exception) {
                throw ApiException(res.code, "${res.code} from $path: ${text.take(200)}")
            }
            // The token endpoint reports pending and denied through 400 bodies, so those
            // must reach the caller as data rather than as an exception.
            if (!res.isSuccessful && res.code != 400) {
                throw ApiException(res.code, "${res.code} from $path: ${text.take(200)}")
            }
            return parsed
        }
    }

    companion object {
        /** Shown on the approval page, so the user knows what is asking. */
        const val CLIENT_ID = "unbent-android"
        private val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()
    }
}
