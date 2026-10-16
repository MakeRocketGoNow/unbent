package com.makerocketgonow.unbent.ui

import java.net.URI
import java.net.URLDecoder

/**
 * Where an address opens, decided without Android so it runs under a plain JVM test.
 *
 * The WebView is this site and nothing else. A page that navigated it somewhere else would
 * be a page running with the app's session cookie, its bridge and its file chooser, so
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
 * origins: `http://localhost:5232` and `http://localhost:8787` are two sites. `about:`,
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

/**
 * The path a link to this site should open in the app, or null when it names another site.
 *
 * Matched on the host alone, because a link and the instance can differ in the rest and
 * still mean the same place: a link shared from the site is `https://`, a debug build
 * pointed at a laptop is `http://` on a port. The path and query are kept and later
 * rebased onto the instance the app is pointed at; a fragment means nothing to the router.
 */
fun linkPath(instance: String, link: String): String? {
    val target = runCatching { URI(link) }.getOrNull() ?: return null
    val site = runCatching { URI(instance.trimEnd('/')) }.getOrNull() ?: return null
    if (target.scheme?.lowercase() !in setOf("http", "https")) return null
    if (target.host == null || !target.host.equals(site.host, ignoreCase = true)) return null
    val path = target.rawPath.orEmpty().ifEmpty { "/" }
    val query = target.rawQuery?.let { "?$it" }.orEmpty()
    return path + query
}

/**
 * The path a `target=_blank` to this site should open in place, or null when it is not
 * one.
 *
 * The WebView has no tabs. Loading the address into the app (`loadUrl`) tears the page
 * down (unsaved edits, an upload in flight) which is why notifications already go
 * through `__unbent.open` instead. A same-origin `_blank` is the same situation: a link
 * in a note, a URL field. Opening in place still leaves the current page, so it keeps
 * what outlives a route change and nothing more. Off-site addresses, and the `about:` /
 * `blob:` / `javascript:` URLs the page made itself, are not paths and stay null.
 */
fun inAppWindowPath(origin: String, url: String): String? {
    if (classify(origin, url) != Destination.InApp) return null
    return linkPath(origin, url)
}

/** A path on this site and nothing that could be read as another host. */
fun isSitePath(path: String): Boolean = path.startsWith("/") && !path.startsWith("//")

private fun sameOrigin(a: URI, b: URI): Boolean =
    a.scheme.equals(b.scheme, ignoreCase = true) &&
        a.host != null && a.host.equals(b.host, ignoreCase = true) &&
        portOf(a) == portOf(b)

private fun portOf(uri: URI): Int = when {
    uri.port != -1 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    else -> 80
}

/**
 * Where the page was before it fell to the site's sign-in at [current], or [fallback].
 *
 * The site's gate sends a signed-out page to `/login?redirect=` with the place it was
 * bounced from (see `returnTo` in `auth-gate.ts`). When the app then finds the session was
 * fine after all (the page only lost the network) that is where it belongs, not the list.
 * The value is anything a URL can carry, so it is only followed when it is a path on this
 * site, and never when it is `/login` again, which the site's own `safeRedirect` refuses
 * for the same reason: a loop waiting for a cause.
 */
fun returnPath(current: String?, fallback: String): String {
    val uri = current?.let { runCatching { URI(it) }.getOrNull() } ?: return fallback
    if (uri.rawPath?.trimEnd('/') != "/login") return fallback
    val raw = uri.rawQuery
        ?.split('&')
        ?.firstOrNull { it.startsWith("redirect=") }
        ?.substringAfter('=')
        ?: return fallback
    val path = runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrNull() ?: return fallback
    if (!isSitePath(path)) return fallback
    if (path.substringBefore('?').trimEnd('/') == "/login") return fallback
    return path
}
