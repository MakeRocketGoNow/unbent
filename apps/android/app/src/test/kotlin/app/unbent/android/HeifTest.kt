package app.unbent.android

import app.unbent.android.share.Heif
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Recognising HEIC, and naming what it becomes.
 *
 * The name is the part that has bitten: JPEG bytes under a `.HEIC` name render on the
 * share path only because the server trusts the declared type, and through the file
 * chooser — where the WebView derives the type from the name — they would not render at
 * all.
 */
class HeifTest {

    @Test
    fun `recognises the HEIF family, whatever the case and parameters`() {
        assertTrue(Heif.isHeif("image/heic"))
        assertTrue(Heif.isHeif("IMAGE/HEIF; charset=binary"))
        assertTrue(Heif.isHeif("image/heic-sequence"))
        assertFalse(Heif.isHeif("image/jpeg"))
        assertFalse(Heif.isHeif(null))
    }

    @Test
    fun `names the JPEG after the original, with the extension the bytes deserve`() {
        assertEquals("IMG_0001.jpg", Heif.jpegName("IMG_0001.HEIC", 0))
        assertEquals("holiday.jpg", Heif.jpegName("holiday.heif", 3))
        // A name without an extension gets one; a hidden one loses its dot, as sanitize does.
        assertEquals("photo.jpg", Heif.jpegName("photo", 0))
        assertEquals("hidden.jpg", Heif.jpegName(".hidden.HEIC", 0))
    }

    @Test
    fun `falls back to a numbered capture when there is no name`() {
        assertEquals("capture-1.jpg", Heif.jpegName(null, 0))
        assertEquals("capture-3.jpg", Heif.jpegName("", 2))
    }
}
