package com.makerocketgonow.unbent

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Address normalization.
 *
 * Everything downstream builds URLs by concatenating "/api/…", so a trailing slash or a
 * pasted path produces a 404 that looks like a server fault rather than a typo.
 */
class PrefsTest {

    @Test
    fun `adds https when the scheme is missing`() {
        assertEquals("https://unbent.app", Prefs.normalizeOrigin("unbent.app"))
    }

    @Test
    fun `drops a trailing slash`() {
        assertEquals("https://unbent.app", Prefs.normalizeOrigin("https://unbent.app/"))
    }

    @Test
    fun `drops a pasted path`() {
        assertEquals("https://unbent.app", Prefs.normalizeOrigin("https://unbent.app/notes/abc"))
    }

    @Test
    fun `keeps an explicit port, which local dev needs`() {
        assertEquals("http://10.0.2.2:5173", Prefs.normalizeOrigin("http://10.0.2.2:5173"))
    }

    @Test
    fun `trims surrounding whitespace`() {
        assertEquals("https://unbent.app", Prefs.normalizeOrigin("  unbent.app  "))
    }

    @Test
    fun `leaves an empty string empty rather than inventing a host`() {
        assertEquals("", Prefs.normalizeOrigin("   "))
    }

    /**
     * The page the Settings row opens. Play requires a deletion path reachable from inside
     * the app, and a self-hosted instance has to get its own page rather than one on
     * unbent.app — which is why this is built from the stored address rather than a
     * constant.
     */
    @Test
    fun `builds the delete-account url for the instance in use`() {
        assertEquals("https://unbent.app/settings/maintenance", Prefs.deleteAccountUrl("https://unbent.app"))
        assertEquals("https://unbent.app/settings/maintenance", Prefs.deleteAccountUrl("https://unbent.app/"))
        assertEquals(
            "http://10.0.2.2:5173/settings/maintenance",
            Prefs.deleteAccountUrl("http://10.0.2.2:5173"),
        )
    }
}
