package app.unbent.android

import app.unbent.android.share.StagedFile
import app.unbent.android.share.Staging
import java.io.File
import java.util.Calendar
import java.util.Date
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Filename and title derivation.
 *
 * These run without a device because the rules they encode come from the server: the API
 * rejects path separators, `.`, `..` and leading dots, and a rejected name silently loses
 * the file the user just shared.
 */
class StagingTest {

    @Test
    fun `keeps an ordinary filename`() {
        assertEquals("receipt.pdf", Staging.sanitize("receipt.pdf", 0, "bin"))
    }

    @Test
    fun `strips a path, keeping only the name`() {
        assertEquals("photo.jpg", Staging.sanitize("/storage/emulated/0/DCIM/photo.jpg", 0, "bin"))
        assertEquals("photo.jpg", Staging.sanitize("C:\\Users\\me\\photo.jpg", 0, "bin"))
    }

    @Test
    fun `strips leading dots, which the API rejects`() {
        assertEquals("hidden.png", Staging.sanitize(".hidden.png", 0, "bin"))
    }

    @Test
    fun `falls back when the name is missing or degenerate`() {
        assertEquals("capture-1.jpg", Staging.sanitize(null, 0, "jpg"))
        assertEquals("capture-2.jpg", Staging.sanitize("", 1, "jpg"))
        assertEquals("capture-3.pdf", Staging.sanitize("..", 2, "pdf"))
        assertEquals("capture-1.jpg", Staging.sanitize(".", 0, "jpg"))
    }

    @Test
    fun `adds an extension when the name has none`() {
        assertEquals("scan.pdf", Staging.sanitize("scan", 0, "pdf"))
    }

    @Test
    fun `removes control characters`() {
        assertEquals("abc.txt", Staging.sanitize("a\u0000b\u001fc.txt", 0, "bin"))
    }

    @Test
    fun `caps an absurdly long name`() {
        val long = "x".repeat(400) + ".pdf"
        assertTrue(Staging.sanitize(long, 0, "bin").length <= 200)
    }

    @Test
    fun `prefers the subject line for the title`() {
        val staged = listOf(staged("photo.jpg"))
        assertEquals("Lab results", Staging.deriveTitle("  Lab results  ", staged))
    }

    @Test
    fun `uses a lone filename stem when there is no subject`() {
        assertEquals("receipt", Staging.deriveTitle(null, listOf(staged("receipt.pdf"))))
    }

    @Test
    fun `falls back to a dated title for a multi-file share`() {
        val when2 = Calendar.getInstance().apply { set(2026, 8, 1, 14, 30, 0) }.time
        val staged = listOf(staged("a.jpg"), staged("b.jpg"))
        assertEquals("Capture 2026-09-01 14:30", Staging.deriveTitle(null, staged, now = when2))
    }

    @Test
    fun `falls back to a dated title when nothing was shared but text`() {
        val when2 = Date(0)
        assertTrue(Staging.deriveTitle("", emptyList(), now = when2).startsWith("Capture "))
    }

    @Test
    fun `titles a shared link by its host, which is what a person recognises`() {
        assertEquals(
            "nytimes.com",
            Staging.deriveTitle(null, emptyList(), "https://www.nytimes.com/2026/09/01/a-slug"),
        )
    }

    @Test
    fun `credits the app a link came from`() {
        assertEquals(
            "nytimes.com — via Chrome",
            Staging.deriveTitle(null, emptyList(), "https://nytimes.com/x", "Chrome"),
        )
    }

    @Test
    fun `titles plain text by its first line`() {
        assertEquals(
            "Pick up prescription",
            Staging.deriveTitle(null, emptyList(), "Pick up prescription\nand call the vet"),
        )
    }

    @Test
    fun `names the source app rather than only a timestamp`() {
        val when2 = Calendar.getInstance().apply { set(2026, 8, 2, 14, 30, 0) }.time
        assertEquals(
            "Photos — 2026-09-02 14:30",
            Staging.deriveTitle(null, listOf(staged("a.jpg"), staged("b.jpg")), null, "Photos", when2),
        )
    }

    @Test
    fun `the subject still wins over everything else`() {
        assertEquals(
            "Lab results",
            Staging.deriveTitle("Lab results", emptyList(), "https://example.com", "Chrome"),
        )
    }

    @Test
    fun `finds a host inside surrounding text, and nothing when there is no url`() {
        assertEquals("example.com", Staging.hostOf("look at https://example.com/x please"))
        assertEquals(null, Staging.hostOf("no link here at all"))
    }

    private fun staged(name: String) = StagedFile(File("/tmp/$name"), name, "application/octet-stream")
}
