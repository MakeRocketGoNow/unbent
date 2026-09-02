package app.unbent.android.ui

import android.webkit.CookieManager
import app.unbent.android.api.SessionCookie

/**
 * The app's session, as the WebView sees it.
 *
 * A WebView's cookie jar belongs to the app that hosts it, which is the whole reason the
 * note body can render in one: the session the app signed in with is stamped into the jar
 * under the cookie's own name, and every request the page makes carries it. No handoff,
 * no token exchange, nothing the user sees. This is what the Trusted Web Activity could
 * never do — Chrome's jar is Chrome's.
 */
object WebSession {

    /**
     * Installs the session for [origin].
     *
     * Before every load rather than once: the jar can be cleared behind the app's back,
     * and a fresh sign-in replaces the session. Setting an identical cookie again is a
     * no-op, so the cost of being safe is nothing.
     */
    fun install(origin: String, session: SessionCookie) {
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        manager.setCookie(origin, session.setCookieLine(origin))
        manager.flush()
    }

    /** Forgets every cookie: signing out, or pointing the app at a different instance. */
    fun clear() {
        val manager = CookieManager.getInstance()
        manager.removeAllCookies(null)
        manager.flush()
    }
}
