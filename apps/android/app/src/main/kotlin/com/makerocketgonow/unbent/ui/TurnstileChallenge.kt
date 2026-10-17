package com.makerocketgonow.unbent.ui

import android.content.Context
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.makerocketgonow.unbent.BuildConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Mints a Turnstile token for the request for a sign-in code, from the instance's own
 * page in a WebView (MAK-243).
 *
 * Where the instance checks a token with that request (`AppConfig.turnstile`), the
 * sign-in screen, which makes the request itself, needs one, and Turnstile runs in a
 * browser and nowhere else. So `/turnstile` is loaded off screen, the way the indexing
 * page is ([HeadlessIndexer]), and the page says what the widget concluded through the
 * bridge: `turnstile` with the token, or `turnstile-error`. The page reads the site key
 * from `/api/config` itself, so the app and the page cannot disagree about whose key it is.
 *
 * Managed Turnstile passes nearly every phone without a tap. When it does want one, the
 * page says `turnstile-interactive` first, and [onChallenge] is handed the view so the
 * screen can draw it for as long as that takes; it is handed null again when the view is
 * done, before it is destroyed, so nothing on screen holds a dead WebView. The view is
 * made with the activity's context rather than the application's for that reason: it may
 * end up in the activity's tree, with its theme.
 *
 * A token is spent by one request, so this is called for every request; the page is
 * cheap, and the alternative is a token held across a press that might never come.
 *
 * `onRenderProcessGone` returns true, as the indexer's does: the default kills the whole
 * app for a renderer that died under a sign-in form, and a failure the form can report
 * is the better end.
 */
object TurnstileChallenge {

    sealed interface Outcome {
        data class Token(val token: String) : Outcome
        /** The instance asks for no token: the check was turned off since the config was read. */
        data object None : Outcome
        data class Failed(val reason: String) : Outcome
        data object TimedOut : Outcome
    }

    /** Long enough for a slow radio and a widget waiting on a tap; well short of forever. */
    const val TIMEOUT_MS = 60_000L

    suspend fun token(
        context: Context,
        origin: String,
        timeoutMs: Long = TIMEOUT_MS,
        onChallenge: (WebView?) -> Unit,
    ): Outcome = withContext(Dispatchers.Main) {
        val outcome = CompletableDeferred<Outcome>()
        val view = WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            addJavascriptInterface(
                NoteBridge { message ->
                    when {
                        message.isTurnstile -> {
                            val token = message.token
                            if (token.isNullOrEmpty()) outcome.complete(Outcome.Failed("empty token"))
                            else outcome.complete(Outcome.Token(token))
                        }
                        message.isTurnstileNone -> outcome.complete(Outcome.None)
                        message.isTurnstileError -> outcome.complete(Outcome.Failed(message.message ?: "turnstile-error"))
                        message.isTurnstileInteractive -> onChallenge(this@apply)
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
                    // The page itself, not one of its resources. Turnstile's own script
                    // failing is reported by the page as `turnstile-error`.
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
            view.loadUrl("$origin/turnstile")
            withTimeoutOrNull(timeoutMs) { outcome.await() } ?: Outcome.TimedOut
        } finally {
            // Off the screen first, if it was ever on it, then torn down.
            onChallenge(null)
            (view.parent as? ViewGroup)?.removeView(view)
            view.stopLoading()
            view.destroy()
        }
    }
}
