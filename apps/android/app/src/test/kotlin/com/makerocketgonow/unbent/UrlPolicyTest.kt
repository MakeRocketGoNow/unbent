package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.ui.Destination
import com.makerocketgonow.unbent.ui.classify
import com.makerocketgonow.unbent.ui.isSitePath
import com.makerocketgonow.unbent.ui.linkPath
import com.makerocketgonow.unbent.ui.returnPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which addresses stay in the WebView. Everything that does runs with the app's session and
 * bridge, so the cases below are mostly about what must *not* stay: the same host on another
 * scheme or port, a host that merely starts like this one, and a protocol-relative path.
 */
class UrlPolicyTest {
    private val site = "https://unbent.example"

    @Test fun `the site's own pages stay`() {
        assertEquals(Destination.InApp, classify(site, "https://unbent.example/notes/abc?view=table"))
        assertEquals(Destination.InApp, classify(site, "https://UNBENT.example/settings"))
        assertEquals(Destination.InApp, classify(site, "https://unbent.example:443/notes"))
    }

    @Test fun `an origin written with a trailing slash is the same site`() {
        assertEquals(Destination.InApp, classify("https://unbent.example/", "https://unbent.example/notes"))
    }

    @Test fun `the same host on another scheme or port is another site`() {
        assertEquals(Destination.Browser("http://unbent.example/notes"), classify(site, "http://unbent.example/notes"))
        assertEquals(Destination.Browser("https://unbent.example:8443/"), classify(site, "https://unbent.example:8443/"))
    }

    @Test fun `a local instance is its own port`() {
        val local = "http://localhost:5232"
        assertEquals(Destination.InApp, classify(local, "http://localhost:5232/notes"))
        assertEquals(Destination.Browser("http://localhost:8787/notes"), classify(local, "http://localhost:8787/notes"))
        assertEquals(Destination.Browser("http://localhost/notes"), classify(local, "http://localhost/notes"))
    }

    @Test fun `a lookalike host leaves`() {
        assertEquals(
            Destination.Browser("https://unbent.example.attacker.test/"),
            classify(site, "https://unbent.example.attacker.test/"),
        )
        assertEquals(Destination.Browser("https://evil.example/x"), classify(site, "https://evil.example/x"))
    }

    @Test fun `what the page made itself stays`() {
        assertEquals(Destination.InApp, classify(site, "about:blank"))
        assertEquals(Destination.InApp, classify(site, "blob:https://unbent.example/1234"))
    }

    @Test fun `anything that is not a web page goes to the system`() {
        assertEquals(Destination.Other("mailto:someone@example.com"), classify(site, "mailto:someone@example.com"))
        assertEquals(Destination.Other("tel:+15555550100"), classify(site, "tel:+15555550100"))
        assertEquals(Destination.Other("intent://x#Intent;end"), classify(site, "intent://x#Intent;end"))
    }

    /**
     * A link to the site opens on the instance the app is pointed at, matched by host so a
     * shared https link still opens in a debug build pointed at a laptop on http.
     */
    @Test fun `a link to the site becomes a path on the app's instance`() {
        assertEquals("/notes/abc?view=table", linkPath(site, "https://unbent.example/notes/abc?view=table#top"))
        assertEquals("/notes", linkPath("http://unbent.example:5232", "https://unbent.example/notes"))
        assertEquals("/", linkPath(site, "https://unbent.example"))
    }

    @Test fun `a link to another site is not the app's`() {
        assertNull(linkPath(site, "https://other.example/notes/abc"))
        assertNull(linkPath("https://my-own.example", "https://unbent.example/notes/abc"))
        assertNull(linkPath(site, "mailto:someone@unbent.example"))
    }

    @Test fun `only a path on this site is followed`() {
        assertTrue(isSitePath("/notes/abc"))
        assertFalse(isSitePath("//evil.example/notes"))
        assertFalse(isSitePath("https://evil.example/"))
        assertFalse(isSitePath(""))
    }

    @Test fun `a page bounced to sign-in goes back where it was`() {
        assertEquals("/notes/abc", returnPath("https://unbent.example/login?redirect=%2Fnotes%2Fabc", "/notes"))
        assertEquals(
            "/notes?view=table",
            returnPath("https://unbent.example/login?x=1&redirect=%2Fnotes%3Fview%3Dtable", "/notes"),
        )
    }

    @Test fun `anything else goes to the list`() {
        assertEquals("/notes", returnPath(null, "/notes"))
        assertEquals("/notes", returnPath("about:blank", "/notes"))
        assertEquals("/notes", returnPath("https://unbent.example/login", "/notes"))
        assertEquals("/notes", returnPath("https://unbent.example/trash?redirect=%2Fsettings", "/notes"))
        assertEquals("/notes", returnPath("https://unbent.example/login?redirect=%2F%2Fevil.example", "/notes"))
        assertEquals("/notes", returnPath("https://unbent.example/login?redirect=https%3A%2F%2Fevil.example", "/notes"))
        assertEquals("/notes", returnPath("https://unbent.example/login?redirect=%2Flogin%3Fredirect%3D%2Fx", "/notes"))
    }
}
