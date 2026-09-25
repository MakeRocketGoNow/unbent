package com.makerocketgonow.unbent.ui

import java.net.URI

/**
 * Where an address opens, decided without Android so it runs under a plain JVM test.
 *
 * The WebView is this site and nothing else. A page that navigated it somewhere else would
 * be a page running with the app's session cookie, its bridge and its file chooser — so
 * everything off the site leaves: a web page for a Custom Tab, where the person's own
 * browser session and address bar are, and anything that is not a web page for whichever
 * app handles it.
 */
sealed interface Destination {
    /** This site, or something the page made itself; stays in the WebView. */
    data object InApp : Destination

    /** A web page elsewhere; a Custom Tab. */
    data class Browser(val url: String) : Destination

    /** `mailto:`, `tel:` and the rest; handed to the system. */
    data class Other(val url: String) : Destination
}

/**
 * [url] against the site at [origin].
 *
 * The same site is the same scheme, host and port, compared as the platform compares
 * origins — `http://localhost:5232` and `http://localhost:8787` are two sites. `about:`,
 * `blob:` and `data:` are the page's own and stay; `javascript:` too, since it only ever
 * reaches here from the page itself. An address that does not parse is sent out rather
 * than trusted.
 */
fun classify(origin: String, url: String): Destination {
    val scheme = url.substringBefore(':', "").lowercase()
    if (scheme in setOf("about", "blob", "data", "javascript")) return Destination.InApp
    if (scheme != "http" && scheme != "https") return Destination.Other(url)
    val target = runCatching { URI(url) }.getOrNull() ?: return Destination.Browser(url)
    val site = runCatching { URI(origin.trimEnd('/')) }.getOrNull() ?: return Destination.Browser(url)
    return if (sameOrigin(site, target)) Destination.InApp else Destination.Browser(url)
}

private fun sameOrigin(a: URI, b: URI): Boolean =
    a.scheme.equals(b.scheme, ignoreCase = true) &&
        a.host != null && a.host.equals(b.host, ignoreCase = true) &&
        portOf(a) == portOf(b)

private fun portOf(uri: URI): Int = when {
    uri.port != -1 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    else -> 80
}
