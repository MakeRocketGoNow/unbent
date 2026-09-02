package app.unbent.android

import android.content.Context
import androidx.core.content.edit

/**
 * The two things this app remembers: which Unbent it talks to, and the session token that
 * proves who it is.
 *
 * Plain `SharedPreferences` in the app's private data directory, deliberately, matching the
 * CLI's reasoning in packages/migrate/src/token-store.ts. What is stored is a revocable
 * 30-day session, not a password: on a non-rooted device the file is unreadable by other
 * apps, and `allowBackup="false"` keeps it off Google's servers. EncryptedSharedPreferences
 * would add a Keystore round trip and a deprecated dependency to protect against an
 * attacker who, having root, could read the key material too.
 *
 * The token is stored per-origin. Pointing the app at a different instance must not send
 * the old instance's token to it — the same trap the CLI's per-origin credentials file
 * avoids.
 */
class Prefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** Origin of the instance, normalized, never with a trailing slash. */
    var instance: String
        get() = prefs.getString(KEY_INSTANCE, null) ?: BuildConfig.DEFAULT_INSTANCE
        set(value) = prefs.edit { putString(KEY_INSTANCE, normalizeOrigin(value)) }

    /** Session token for the current instance, or null when this phone is not signed in. */
    var token: String?
        get() = prefs.getString(tokenKey(instance), null)
        set(value) = prefs.edit {
            if (value == null) remove(tokenKey(instance)) else putString(tokenKey(instance), value)
        }

    val isSignedIn: Boolean get() = !token.isNullOrEmpty()

    /**
     * Whether a finished capture opens the note it made.
     *
     * On by default. A share is deliberately fire-and-forget — no title prompt, no notebook
     * picker — which is right at the moment of capture and wrong a week later, when the note
     * is called "Capture 2026-09-02 14:30" and nobody remembers what it was. Opening it puts
     * naming and filing one tap away while the reason is still fresh, without making anyone
     * stop to type before the thing is saved.
     */
    var openAfterCapture: Boolean
        get() = prefs.getBoolean(KEY_OPEN_AFTER, true)
        set(value) = prefs.edit { putBoolean(KEY_OPEN_AFTER, value) }

    fun clearToken() {
        token = null
    }

    private fun tokenKey(origin: String) = "$KEY_TOKEN_PREFIX${normalizeOrigin(origin)}"

    companion object {
        private const val NAME = "unbent"
        private const val KEY_INSTANCE = "instance"
        private const val KEY_TOKEN_PREFIX = "token:"
        private const val KEY_OPEN_AFTER = "openAfterCapture"

        /**
         * Trims a typed address to a bare origin.
         *
         * Users type "unbent.app", "https://unbent.app/", sometimes with a path from a
         * copied link. Everything downstream concatenates "/api/…", so a trailing slash or
         * a stray path produces a URL that 404s in a way that looks like a server fault.
         */
        fun normalizeOrigin(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return trimmed
            val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
            return try {
                val url = java.net.URI(withScheme)
                val port = if (url.port == -1) "" else ":${url.port}"
                "${url.scheme}://${url.host}$port"
            } catch (_: Exception) {
                withScheme.trimEnd('/')
            }
        }
    }
}
