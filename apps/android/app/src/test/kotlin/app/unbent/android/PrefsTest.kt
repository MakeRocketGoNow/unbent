package app.unbent.android

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
}
