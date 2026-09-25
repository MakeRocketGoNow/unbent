package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.ApiJson
import com.makerocketgonow.unbent.ui.BridgeMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The page's messages, as the app reads them.
 *
 * The protocol is a handful of JSON shapes agreed with apps/web/src/app-bridge.ts; what
 * is worth pinning is that each field is read only with the type it belongs to, and that
 * a message with more in it than this build knows still parses — a page from a newer
 * deploy must not break the screen around it.
 */
class NoteBridgeTest {

    @Test
    fun `a message from a newer page still parses`() {
        val message = ApiJson.decodeFromString<BridgeMessage>(
            """{"type":"index-done","indexed":2,"unusable":0,"failed":0,"seconds":4}""",
        )
        assertEquals(2, message.indexed)
    }

    @Test
    fun `an index-done message carries its counts`() {
        val message = ApiJson.decodeFromString<BridgeMessage>(
            """{"type":"index-done","indexed":3,"unusable":1,"failed":0}""",
        )
        assertEquals(true, message.isIndexDone)
        assertEquals(3, message.indexed)
        assertEquals(1, message.unusable)
        assertEquals(0, message.failed)
        assertNull(message.message)
    }

    @Test
    fun `an index-error message carries what went wrong`() {
        val message = ApiJson.decodeFromString<BridgeMessage>("""{"type":"index-error","message":"R2 is on fire"}""")
        assertEquals(true, message.isIndexError)
        assertEquals("R2 is on fire", message.message)
        assertNull(message.indexed)
    }

    @Test
    fun `a theme message carries the page's ground and nothing else`() {
        val message = ApiJson.decodeFromString<BridgeMessage>("""{"type":"theme","background":"#16151a"}""")
        assertEquals("#16151a", message.themeBackground)
        assertNull(message.indexed)
        assertNull(message.message)
    }

    @Test
    fun `a background outside a theme message is not a theme`() {
        val message = ApiJson.decodeFromString<BridgeMessage>("""{"type":"ready","background":"#000000"}""")
        assertNull(message.themeBackground)
    }

    @Test
    fun `the site's sign-out and settings requests parse`() {
        assertEquals(true, ApiJson.decodeFromString<BridgeMessage>("""{"type":"signed-out"}""").isSignedOut)
        assertEquals(true, ApiJson.decodeFromString<BridgeMessage>("""{"type":"app-settings"}""").isAppSettings)
        assertEquals(true, ApiJson.decodeFromString<BridgeMessage>("""{"type":"unauthorized"}""").isUnauthorized)
    }
}
