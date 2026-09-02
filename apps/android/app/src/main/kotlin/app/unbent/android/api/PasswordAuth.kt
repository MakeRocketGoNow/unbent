package app.unbent.android.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Email and password, against Better Auth's own endpoints.
 *
 * Offered only when the instance says so (`AppConfig.password`): it exists for self-hosted
 * instances, which cannot register OAuth callbacks with Google or GitHub on anyone's
 * behalf, and unbent.app leaves it off. Nothing is stored here but the resulting session;
 * the password goes to the server once and is forgotten.
 */
class PasswordAuth(
    private val origin: String,
    private val client: OkHttpClient = UnbentApi.shared,
) {
    fun signIn(email: String, password: String): SessionCookie = post(
        "/api/auth/sign-in/email",
        buildJsonObject {
            put("email", email)
            put("password", password)
        },
        "Sign-in",
    )

    /** Creates an account. The instance's allowlist decides, and its refusal is the message. */
    fun signUp(email: String, password: String, name: String): SessionCookie = post(
        "/api/auth/sign-up/email",
        buildJsonObject {
            put("email", email)
            put("password", password)
            put("name", name)
        },
        "Sign-up",
    )

    private fun post(path: String, payload: JsonObject, what: String): SessionCookie {
        val req = Request.Builder()
            .url("$origin$path")
            // Better Auth enforces CSRF by requiring a trusted Origin.
            .header("Origin", origin)
            .post(payload.toString().toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) throw ApiException(res.code, "$what failed: ${res.code}", text)
            return SessionCookie.fromSetCookie(res.headers("Set-Cookie"))
                ?: throw ApiException(res.code, "$what returned no session.", text)
        }
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()
    }
}
