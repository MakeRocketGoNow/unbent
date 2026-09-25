package com.makerocketgonow.unbent.ui

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import com.makerocketgonow.unbent.api.ApiJson
import kotlinx.serialization.Serializable

/**
 * What a page tells the app. Mirrors `AppMessage` in apps/web/src/app-bridge.ts.
 *
 * From the site the app hosts: `theme` with the page's ground colour as `background`, for
 * the strips behind the system bars; `unauthorized` when the page believes the session is
 * gone, which the app checks before believing; `signed-out` when the person signed out on
 * the page; and `app-settings` to open the app's own settings.
 *
 * From the indexing page the capture job hosts: `ready`, then the counts with
 * `index-done` or `message` with `index-error`.
 *
 * `state` with `save`, `pending` with `upload`, and `missing` are the embedded note page's,
 * and go when it does.
 *
 * Unknown types are ignored rather than failing, so a page from a newer deploy can say
 * something this build has never heard of without breaking the screen around it.
 */
@Serializable
data class BridgeMessage(
    val type: String,
    val state: String? = null,
    val pending: Int? = null,
    val indexed: Int? = null,
    val unusable: Int? = null,
    val failed: Int? = null,
    val message: String? = null,
    val background: String? = null,
) {
    val isReady get() = type == "ready"
    val isUnauthorized get() = type == "unauthorized"
    val isMissing get() = type == "missing"
    val isIndexDone get() = type == "index-done"
    val isIndexError get() = type == "index-error"
    val isSignedOut get() = type == "signed-out"
    val isAppSettings get() = type == "app-settings"
    val themeBackground get() = if (type == "theme") background else null
    val saveState get() = if (type == "save") state else null
    val uploadsPending get() = if (type == "upload") pending else null
}

/**
 * The app's end of the bridge, installed on the WebView as `window.UnbentApp`.
 *
 * WebView calls [postMessage] on a thread of its own; the handler runs on the main thread,
 * which is where the screen state it changes lives.
 *
 * The `save` calls are how an export reaches Downloads; see [SaveStreams]. They answer on
 * the bridge's own thread and return only once the bytes are written, which is what
 * keeps a fast page from outrunning the phone's storage. A WebView given no [saves] — the
 * indexing page's — answers every one as a failure, and the page never asks.
 */
class NoteBridge(
    private val saves: SaveStreams? = null,
    private val onMessage: (BridgeMessage) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(json: String) {
        val message = runCatching { ApiJson.decodeFromString<BridgeMessage>(json) }.getOrNull() ?: return
        main.post { onMessage(message) }
    }

    @JavascriptInterface
    fun saveBegin(name: String, type: String): String = saves?.begin(name, type).orEmpty()

    @JavascriptInterface
    fun saveChunk(id: String, base64: String): Boolean = saves?.chunk(id, base64) ?: false

    @JavascriptInterface
    fun saveEnd(id: String): Boolean = saves?.end(id) ?: false

    @JavascriptInterface
    fun saveAbort(id: String) {
        saves?.abort(id)
    }

    companion object {
        /** The name the page looks for; see app-bridge.ts. */
        const val NAME = "UnbentApp"

        /** Asks the page to save whatever is pending; it answers with a `save` message. */
        const val FLUSH_SCRIPT = "window.__unbent && window.__unbent.flush && window.__unbent.flush();"

        /**
         * Asks the page to drop its uploads and their placeholders, before a flush. The
         * page reports the pending count as 0 and the body as dirty before this returns.
         */
        const val ABANDON_SCRIPT =
            "window.__unbent && window.__unbent.abandonUploads && window.__unbent.abandonUploads();"
    }
}
