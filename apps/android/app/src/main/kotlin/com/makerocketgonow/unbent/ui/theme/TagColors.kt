package com.makerocketgonow.unbent.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/**
 * The site's palette for tags and select options, for the chips this app draws itself.
 *
 * A tag's colour is an index into this list, stored on its row by the server and sent on
 * every tag (`Tag.color`); the app never decides one. It used to be a hash of the word,
 * which the site ran and this app would have had to run the same way to agree with it;
 * the stored index is what lets the two agree without sharing code. The ten hues are the
 * stylesheet's `--tint-0` to `--tint-9` (nine hues and a grey), in the same order, and a
 * chip's fill and ink are mixed from the hue as the stylesheet mixes them: a wash of the
 * hue over the surface, and the hue blended most of the way into the surface's text
 * colour, at one pair of ratios on the light theme and a deeper pair on the dark.
 *
 * An index the list does not have (null from a server older than the colours, or a
 * palette that has grown past this copy) draws the neutral chip: the text colour's own
 * wash, which is what the site draws for a tag with no colour yet.
 */
object TagColors {
    val hues: List<Color> = listOf(
        Color(0xFFC94F58), // red
        Color(0xFFD2742F), // orange
        Color(0xFFC9A227), // yellow
        Color(0xFF5F9A48), // green
        Color(0xFF3B9A8F), // teal
        Color(0xFF4A7FC7), // blue
        Color(0xFF8B63C7), // purple
        Color(0xFFC9568F), // pink
        Color(0xFF9A6B4A), // brown
        Color(0xFF8C8781), // grey
    )

    /** The hue an index names, or the ink itself for none, as the stylesheet's `--chip-hue` falls back. */
    fun hue(index: Int?, onSurface: Color): Color =
        if (index != null && index in hues.indices) hues[index] else onSurface

    /** A chip's fill: the hue washed over the surface. */
    fun fill(index: Int?, surface: Color, onSurface: Color, dark: Boolean): Color =
        lerp(surface, hue(index, onSurface), if (dark) 0.26f else 0.16f)

    /** A chip's text: the hue blended toward the surface's text colour, further on dark. */
    fun ink(index: Int?, onSurface: Color, dark: Boolean): Color =
        lerp(onSurface, hue(index, onSurface), if (dark) 0.50f else 0.70f)
}
