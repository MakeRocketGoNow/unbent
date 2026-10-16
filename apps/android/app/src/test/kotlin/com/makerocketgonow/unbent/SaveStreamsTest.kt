package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.ui.SaveStreams
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app's half of an export streamed into Downloads. What matters is that the bytes
 * arrive whole and in order, and that a save which does not finish is never kept: a
 * half-written zip in Downloads would look like a backup and not be one.
 */
class SaveStreamsTest {

    private class Fake {
        val bytes = ByteArrayOutputStream()
        var kept = false
        var discarded = false
        var created: String? = null
        var failWrites = false

        val saves = SaveStreams { name, _ ->
            created = name
            val stream = object : OutputStream() {
                override fun write(b: Int) {
                    if (failWrites) throw IOException("disk full")
                    bytes.write(b)
                }
                override fun write(b: ByteArray, off: Int, len: Int) {
                    if (failWrites) throw IOException("disk full")
                    bytes.write(b, off, len)
                }
            }
            SaveStreams.Target(stream, keep = { kept = true }, discard = { discarded = true })
        }
    }

    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    @Test
    fun `pieces are written in order and kept at the end`() {
        val fake = Fake()
        val id = fake.saves.begin("unbent-export-2026-09-25.zip", "application/zip")
        assertTrue(fake.saves.chunk(id, b64(byteArrayOf(1, 2, 3))))
        assertTrue(fake.saves.chunk(id, b64(byteArrayOf(4, 5))))
        assertTrue(fake.saves.end(id))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), fake.bytes.toByteArray())
        assertTrue(fake.kept)
        assertFalse(fake.discarded)
        assertEquals("unbent-export-2026-09-25.zip", fake.created)
    }

    @Test
    fun `an abandoned save is discarded`() {
        val fake = Fake()
        val id = fake.saves.begin("a.zip", "application/zip")
        fake.saves.chunk(id, b64(byteArrayOf(1)))
        fake.saves.abort(id)
        assertTrue(fake.discarded)
        assertFalse(fake.kept)
        // Already gone: a second abort or a late piece does nothing and says so.
        fake.saves.abort(id)
        assertFalse(fake.saves.chunk(id, b64(byteArrayOf(2))))
        assertFalse(fake.saves.end(id))
    }

    @Test
    fun `a failed write ends the save and throws the file away`() {
        val fake = Fake()
        val id = fake.saves.begin("a.zip", "application/zip")
        fake.failWrites = true
        assertFalse(fake.saves.chunk(id, b64(byteArrayOf(1))))
        assertTrue(fake.discarded)
        assertFalse(fake.saves.end(id))
    }

    @Test
    fun `every open save goes when the WebView does`() {
        val fake = Fake()
        fake.saves.begin("a.zip", "application/zip")
        fake.saves.abortAll()
        assertTrue(fake.discarded)
    }

    @Test
    fun `nothing is promised when nothing could be created`() {
        val saves = SaveStreams { _, _ -> null }
        assertEquals("", saves.begin("a.zip", "application/zip"))
    }

    @Test
    fun `a name cannot reach outside Downloads or hide itself`() {
        assertEquals("passwd", SaveStreams.safeName("../../etc/passwd"))
        assertEquals("export.zip", SaveStreams.safeName(".export.zip"))
        assertEquals("a b.zip", SaveStreams.safeName("a\u0000 b.zip"))
        assertEquals("unbent-export.zip", SaveStreams.safeName("  "))
    }
}
