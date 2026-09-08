package com.makerocketgonow.unbent.api

/**
 * The one credential this app holds: the session cookie Better Auth set when it signed in.
 *
 * Stored as the cookie itself — name and signed value — rather than the bare session token
 * the JSON body also carries, because the same string serves two clients. OkHttp sends the
 * value as `Authorization: Bearer`, which the API's bearer plugin accepts unchanged since a
 * signed value already carries its signature. The WebView gets the cookie stamped into its
 * jar under the same name, and so shares the session with no exchange of any kind.
 *
 * The name is taken from the response rather than assumed: Better Auth prefixes it with
 * `__Secure-` on https origins and not on the http origin an emulator uses to reach a dev
 * server, and a guess that got that wrong would fail only on the other kind of instance.
 */
data class SessionCookie(val name: String, val value: String) {

    /** The bearer credential: the signed cookie value, exactly as the server set it. */
    val bearer: String get() = value

    /**
     * The `Set-Cookie` line to install in a WebView's jar for [origin].
     *
     * `Secure` only on https: a cookie marked Secure is silently dropped by an http origin,
     * which is how a dev instance would end up showing a sign-in page inside the app.
     * HttpOnly because the page has no business reading it; the bridge is how the page
     * and the app talk.
     */
    fun setCookieLine(origin: String): String = buildString {
        append(name).append('=').append(value)
        append("; Path=/; HttpOnly")
        if (origin.startsWith("https://")) append("; Secure")
    }

    companion object {
        private const val SUFFIX = "session_token"

        /**
         * Finds the session cookie among a response's `Set-Cookie` headers.
         *
         * A sign-in sets several: the session, the cached session data, sometimes a state
         * cookie being cleared. The wanted one ends in `session_token` and carries a value;
         * a `Max-Age=0` line is a deletion, not a session, whatever its name.
         */
        fun fromSetCookie(headers: List<String>): SessionCookie? {
            for (line in headers) {
                val pair = line.substringBefore(';').trim()
                val eq = pair.indexOf('=')
                if (eq <= 0) continue
                val name = pair.substring(0, eq).trim()
                val value = pair.substring(eq + 1).trim()
                if (!name.endsWith(SUFFIX) || value.isEmpty()) continue

                val attributes = line.substringAfter(';', "")
                    .split(';')
                    .map { it.trim().lowercase() }
                if ("max-age=0" in attributes) continue

                return SessionCookie(name, value)
            }
            return null
        }
    }
}
