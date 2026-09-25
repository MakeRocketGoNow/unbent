package com.makerocketgonow.unbent.ui

import android.content.Context
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.makerocketgonow.unbent.BuildConfig
import com.makerocketgonow.unbent.api.SessionCookie
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Runs the site's indexing page in a WebView that is never shown.
 *
 * `/embed/index-files?note=<id>` extracts the text of one note's PDFs with the same
 * pdf.js the site uses, and reports through the bridge. This loads it, waits for the
 * page's one final word, and tears the WebView down. The page is scoped to a note by
 * design: a phone must never be handed the account's backlog to pull over a radio.
 *
 * On the main thread because a WebView is a View, whatever thread the caller is on. The
 * application context is enough for one that is never attached to a window — there is no
 * theme to inherit and no window to draw in — and it lets a background job own the view
 * without an activity.
 *
 * `onRenderProcessGone` returns true. The default, false, has the system kill the whole
 * app process when the renderer dies, which for a job means WorkManager restarting it
 * straight into the same crash. Returning true keeps the process, and the job reports a
 * failure instead. A rerun after that is harmless: the page asks the server what is still
 * pending, so nothing is extracted twice.
 */
object HeadlessIndexer {

    sealed interface Outcome {
        data class Done(val indexed: Int, val failed: Int) : Outcome
        data object Unauthorized : Outcome
        data class Failed(val reason: String) : Outcome
        data object TimedOut : Outcome
    }

    suspend fun index(
        context: Context,
        origin: String,
        session: SessionCookie,
        noteId: String,
        timeoutMs: Long,
    ): Outcome = withContext(Dispatchers.Main) {
        val outcome = CompletableDeferred<Outcome>()

        val view = WebView(context.applicationContext).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            addJavascriptInterface(
                NoteBridge { message ->
                    when {
                        message.isIndexDone ->
                            outcome.complete(Outcome.Done(message.indexed ?: 0, message.failed ?: 0))
                        message.isIndexError ->
                            outcome.complete(Outcome.Failed(message.message ?: "index-error"))
                        message.isUnauthorized -> outcome.complete(Outcome.Unauthorized)
                    }
                },
                NoteBridge.NAME,
            )
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    // The page itself, not one of its resources: a font that fails to load
                    // is not a reason to give up on the extraction.
                    if (request.isForMainFrame) {
                        outcome.complete(Outcome.Failed("${error.errorCode}: ${error.description}"))
                    }
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: WebResourceResponse,
                ) {
                    if (request.isForMainFrame) {
                        outcome.complete(Outcome.Failed("HTTP ${errorResponse.statusCode}"))
                    }
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    outcome.complete(Outcome.Failed("renderer gone"))
                    return true
                }
            }
        }

        // A page nobody can see is otherwise impossible to look at; chrome://inspect can.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        try {
            // The cookie first, every time, as the main WebView does: the jar can be cleared
            // behind the app's back, and a page loaded without it reports `unauthorized`.
            WebSession.install(origin, session)
            view.loadUrl("$origin/embed/index-files?note=${Uri.encode(noteId)}")
            withTimeoutOrNull(timeoutMs) { outcome.await() } ?: Outcome.TimedOut
        } finally {
            view.stopLoading()
            view.destroy()
        }
    }
}
