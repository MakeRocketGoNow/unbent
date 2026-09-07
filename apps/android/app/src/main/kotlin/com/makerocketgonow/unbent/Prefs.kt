package com.makerocketgonow.unbent

import android.content.Context
import androidx.core.content.edit
import com.makerocketgonow.unbent.api.SessionCookie

/**
 * The two things this app remembers: which Unbent it talks to, and the session cookie that
 * proves who it is.
 *
 * Plain `SharedPreferences` in the app's private data directory, deliberately, matching the
 * CLI's reasoning in packages/migrate/src/token-store.ts. What is stored is a revocable
 * 30-day session, not a password: on a non-rooted device the file is unreadable by other
 * apps, and `allowBackup="false"` keeps it off Google's servers. EncryptedSharedPreferences
 * would add a Keystore round trip and a deprecated dependency to protect against an
 * attacker who, having root, could read the key material too.
 *
 * The session is stored per-origin. Pointing the app at a different instance must not send
 * the old instance's credential to it — the same trap the CLI's per-origin credentials file
 * avoids.
 */
class Prefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** Origin of the instance, normalized, never with a trailing slash. */
    var instance: String
        get() = prefs.getString(KEY_INSTANCE, null) ?: BuildConfig.DEFAULT_INSTANCE
        set(value) = prefs.edit { putString(KEY_INSTANCE, normalizeOrigin(value)) }

    /**
     * The session cookie for the current instance, or null when this phone is not signed in.
     *
     * The cookie rather than a bare token: see [SessionCookie]. Name and value are stored
     * separately because the name is part of what was learned from the server, not
     * something to guess again when the cookie is put back into a WebView.
     */
    var session: SessionCookie?
        get() {
            val name = prefs.getString(sessionKey("name", instance), null) ?: return null
            val value = prefs.getString(sessionKey("value", instance), null) ?: return null
            return SessionCookie(name, value)
        }
        set(value) = prefs.edit {
            if (value == null) {
                remove(sessionKey("name", instance))
                remove(sessionKey("value", instance))
            } else {
                putString(sessionKey("name", instance), value.name)
                putString(sessionKey("value", instance), value.value)
            }
        }

    val isSignedIn: Boolean get() = session != null

    /**
     * Where the last capture was filed, offered first by the next one.
     *
     * A share sheet is used in runs — five receipts in a row go to the same place — and
     * the notebook picked last time is the likeliest answer. Per origin like the session,
     * since a notebook name belongs to one instance's account.
     */
    var lastNotebook: String?
        get() = prefs.getString("lastNotebook:${normalizeOrigin(instance)}", null)
        set(value) = prefs.edit {
            val key = "lastNotebook:${normalizeOrigin(instance)}"
            if (value == null) remove(key) else putString(key, value)
        }

    fun clearSession() {
        session = null
    }

    private fun sessionKey(part: String, origin: String) = "session.$part:${normalizeOrigin(origin)}"

    companion object {
        private const val NAME = "unbent"
        private const val KEY_INSTANCE = "instance"

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
