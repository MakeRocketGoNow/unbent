package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.ui.Destination
import com.makerocketgonow.unbent.ui.classify
import org.junit.Assert.assertEquals
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
}
