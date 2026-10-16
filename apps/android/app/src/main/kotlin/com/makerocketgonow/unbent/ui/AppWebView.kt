package com.makerocketgonow.unbent.ui

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.webkit.URLUtil
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.makerocketgonow.unbent.Prefs
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/*
 * What any WebView of this site needs from the app, whichever screen holds it: the page's
 * dark mode on older phones, a way to ask the page something and wait for the answer,
 * downloads that carry the session, and where a link goes.
 */

/**
 * Dark mode for the page, on devices that do not derive it from the app theme.
 *
 * From API 33 the WebView reads `prefers-color-scheme` off the activity's theme and this
 * does nothing. Below that, force-dark with the web-theme-only strategy asks the page for
 * its own dark stylesheet, which it has, and never algorithmically inverts anything.
 */
@Suppress("DEPRECATION")
internal fun applyDarkMode(view: WebView, dark: Boolean) {
    if (Build.VERSION.SDK_INT >= 33) return
    val settings = view.settings
    if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
        WebSettingsCompat.setForceDark(
            settings,
            if (dark) WebSettingsCompat.FORCE_DARK_ON else WebSettingsCompat.FORCE_DARK_OFF,
        )
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK_STRATEGY)) {
        WebSettingsCompat.setForceDarkStrategy(settings, WebSettingsCompat.DARK_STRATEGY_WEB_THEME_DARKENING_ONLY)
    }
}

/**
 * `evaluateJavascript`, awaited: resumes with the script's result, as JSON: `"true"` for
 * a page that answered true, `"null"` for a page with nothing registered to answer.
 *
 * Bounded, because a WebView destroyed before the script finishes never calls back, and
 * whatever waited on it would wait forever. Null when it timed out.
 */
internal suspend fun WebView.evaluate(script: String): String? =
    withTimeoutOrNull(1_000) {
        suspendCancellableCoroutine { cont ->
            evaluateJavascript(script) { result -> if (cont.isActive) cont.resume(result) }
        }
    }

/**
 * A file the page asked to download, fetched with the app's session.
 *
 * DownloadManager runs outside the WebView and so outside its cookie jar; the cookie goes
 * on the request by hand. Read when the download starts rather than when the WebView was
 * made, since a sign-in in between replaces it. Into the public Downloads folder where the
 * platform allows it without a permission, and into the app's own files below that.
 */
internal fun download(
    context: Context,
    url: String,
    contentDisposition: String?,
    mimeType: String?,
) {
    val session = Prefs(context).session
    val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
    val request = DownloadManager.Request(Uri.parse(url)).apply {
        if (session != null) addRequestHeader("Cookie", "${session.name}=${session.value}")
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        } else {
            setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
        }
    }
    runCatching { context.getSystemService(DownloadManager::class.java)?.enqueue(request) }
}

/**
 * Sends a link the site does not own where it belongs: a web page to a Custom Tab, anything
 * else (mail, a phone number) to whichever app handles it. Nothing at all when nothing
 * does, rather than a crash.
 */
internal fun openOutside(context: Context, destination: Destination) {
    runCatching {
        when (destination) {
            is Destination.Browser ->
                CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(destination.url))
            is Destination.Other ->
                context.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(destination.url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            Destination.InApp -> Unit
        }
    }.onFailure { if (it !is ActivityNotFoundException) throw it }
}

/**
 * Keeps the site in the WebView and sends every other address out of it; see [classify].
 */
internal class AppWebViewClient(
    private val origin: String,
    private val context: Context,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val destination = classify(origin, request.url.toString())
        if (destination == Destination.InApp) return false
        // A frame inside the page never opens a browser or another app; only the person
        // tapping something at the top level does. A frame navigating off the site is
        // refused rather than shown, because the bridge is exposed to every frame in this
        // WebView and a page from anywhere else must not reach it. This is not the whole
        // fence: a frame's first load, from its `src`, never comes through here. The site
        // has no frames, and one that ever loads another origin needs its own answer.
        if (!request.isForMainFrame) return true
        openOutside(context, destination)
        return true
    }
}
