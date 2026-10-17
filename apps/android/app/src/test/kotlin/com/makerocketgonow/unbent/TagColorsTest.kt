package com.makerocketgonow.unbent

import androidx.compose.ui.graphics.Color
import com.makerocketgonow.unbent.ui.theme.TagColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The palette is the site's, by index, and an index the app does not know draws the
 * neutral chip rather than crashing or picking a colour of its own: the server decides.
 */
class TagColorsTest {
    private val surface = Color.White
    private val onSurface = Color.Black

    @Test
    fun `ten hues, in the stylesheet's order`() {
        assertEquals(10, TagColors.hues.size)
        assertEquals(Color(0xFF5F9A48), TagColors.hue(3, onSurface)) // green
        assertEquals(Color(0xFF8C8781), TagColors.hue(9, onSurface)) // grey
    }

    @Test
    fun `no colour, or one off the palette, is the neutral chip`() {
        assertEquals(onSurface, TagColors.hue(null, onSurface))
        assertEquals(onSurface, TagColors.hue(10, onSurface))
        assertEquals(onSurface, TagColors.hue(-1, onSurface))
        assertEquals(TagColors.fill(null, surface, onSurface, dark = false), TagColors.fill(42, surface, onSurface, dark = false))
    }

    @Test
    fun `a fill is a wash of the hue, deeper on dark, and the ink carries the hue`() {
        val light = TagColors.fill(5, surface, onSurface, dark = false)
        val dark = TagColors.fill(5, Color.Black, Color.White, dark = true)
        // A light wash stays close to the surface; the dark one is further from its own.
        assertNotEquals(surface, light)
        assertNotEquals(Color.Black, dark)
        val ink = TagColors.ink(5, onSurface, dark = false)
        assertNotEquals(onSurface, ink)
        // Blue's ink leans blue: more blue than red in it.
        assert(ink.blue > ink.red)
    }
}
