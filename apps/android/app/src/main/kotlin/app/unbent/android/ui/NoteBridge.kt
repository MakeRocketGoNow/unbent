package app.unbent.android.ui

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import app.unbent.android.api.ApiJson
import kotlinx.serialization.Serializable

/**
 * What the embedded page tells the app. Mirrors `AppMessage` in apps/web/src/app-bridge.ts.
 *
 * `state` accompanies `save` only, and is one of the web autosave's five states. Unknown
 * types are ignored rather than failing, so a page from a newer deploy can say something
 * this build has never heard of without breaking the screen around it.
 */
@Serializable
data class BridgeMessage(val type: String, val state: String? = null) {
    val isReady get() = type == "ready"
    val isUnauthorized get() = type == "unauthorized"
    val isMissing get() = type == "missing"
    val saveState get() = if (type == "save") state else null
}

/**
 * The app's end of the bridge, installed on the WebView as `window.UnbentApp`.
 *
 * WebView calls [postMessage] on a thread of its own; the handler runs on the main thread,
 * which is where the screen state it changes lives.
 */
class NoteBridge(private val onMessage: (BridgeMessage) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(json: String) {
        val message = runCatching { ApiJson.decodeFromString<BridgeMessage>(json) }.getOrNull() ?: return
        main.post { onMessage(message) }
    }

    companion object {
        /** The name the page looks for; see app-bridge.ts. */
        const val NAME = "UnbentApp"

        /** Asks the page to save whatever is pending; it answers with a `save` message. */
        const val FLUSH_SCRIPT = "window.__unbent && window.__unbent.flush && window.__unbent.flush();"
    }
}
