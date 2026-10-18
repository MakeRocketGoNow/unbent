package com.makerocketgonow.unbent.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * A six-digit code by email, against Better Auth's own endpoints.
 *
 * The way in that needs no account anywhere else, and on a phone the reason it is a code
 * rather than a link: a link tapped in a mail app opens in whichever browser that app
 * prefers, which is not this app and often not even the browser holding a session, so the
 * sign-in lands somewhere the user cannot see. A code is typed back into the screen that
 * asked for it.
 *
 * Sign-up and sign-in are one flow (an address with no account gets one) so there is no
 * separate registration call here. The instance's allowlist still decides, and [signIn]
 * surfaces its refusal through [ApiException.serverMessage].
 */
class EmailOtpAuth(
    private val origin: String,
    private val client: OkHttpClient = UnbentApi.shared,
) {
    /**
     * Asks for a code. Succeeds whether or not the address has an account, which is
     * deliberate upstream: answering differently would make this a way to ask whether a
     * given person uses this instance.
     *
     * [captchaToken] is the Turnstile token the instance asks for with this request where
     * it has the check on (`AppConfig.turnstile`), minted by its `/turnstile` page in a
     * web view ([com.makerocketgonow.unbent.ui.TurnstileChallenge]) and sent in the header
     * the server's plugin reads. Null where the instance asks for none: a server that
     * asks for no token must be sent none.
     */
    fun sendCode(email: String, captchaToken: String? = null) {
        val req = Request.Builder()
            .url("$origin/api/auth/email-otp/send-verification-otp")
            // Better Auth enforces CSRF by requiring a trusted Origin.
            .header("Origin", origin)
            .apply { if (captchaToken != null) header(CAPTCHA_HEADER, captchaToken) }
            .post(
                buildJsonObject {
                    put("email", email)
                    put("type", "sign-in")
                }.toString().toRequestBody(JSON),
            )
            .build()

        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) {
                val text = res.body.string()
                throw ApiException(res.code, "Could not send a code: ${res.code}", text)
            }
        }
    }

    /** Trades a code for a session. The code is single-use and burns after three tries. */
    fun signIn(email: String, code: String): SessionCookie = post(
        "/api/auth/sign-in/email-otp",
        buildJsonObject {
            put("email", email)
            put("otp", code)
        },
    )

    private fun post(path: String, payload: JsonObject): SessionCookie {
        val req = Request.Builder()
            .url("$origin$path")
            .header("Origin", origin)
            .post(payload.toString().toRequestBody(JSON))
            .build()

        client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, "Sign-in failed: ${res.code}", text)
            return SessionCookie.fromSetCookie(res.headers("Set-Cookie"))
                ?: throw ApiException(res.code, "Sign-in returned no session.", text)
        }
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaTypeOrNull()

        /** The header the token travels in; the same one the web app sends (`turnstile.ts`). */
        const val CAPTCHA_HEADER = "x-captcha-response"
    }
}
