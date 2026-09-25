package com.makerocketgonow.unbent

import androidx.compose.ui.graphics.Color
import com.makerocketgonow.unbent.ui.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The page's ground colour, as the shell reads it to paint the strips behind the system
 * bars. Anything that is not the six-digit hex the site sends is ignored rather than
 * painted, so a page from a newer deploy that sends something else leaves the theme's own
 * surface showing instead of black.
 */
class PageColourTest {
    @Test
    fun `reads the page's hex`() {
        assertEquals(Color(0xFFFBFAF8), MainActivity.parseHex("#fbfaf8"))
        assertEquals(Color(0xFF16151A), MainActivity.parseHex(" #16151A "))
    }

    @Test
    fun `ignores anything else`() {
        assertNull(MainActivity.parseHex("rgb(22, 21, 26)"))
        assertNull(MainActivity.parseHex("#fff"))
        assertNull(MainActivity.parseHex("#gggggg"))
        assertNull(MainActivity.parseHex(""))
    }
}
