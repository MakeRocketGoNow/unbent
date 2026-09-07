package com.makerocketgonow.unbent.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/*
 * Material 3 with Unbent's green substituted for the stock purple, matching the web app so
 * the two do not look like different products. Only the roles the app actually paints are
 * overridden — buttons, their text, and the surfaces behind them — because a partial
 * palette that leaves related roles at their defaults reads worse than either scheme alone.
 *
 * The same values as res/values/colors.xml and values-night/colors.xml, which the XML
 * theme still needs for the window background before Compose draws its first frame.
 */
private val Green = Color(0xFF2F6B4F)
private val GreenDark = Color(0xFF12301F)
private val GreenContainer = Color(0xFFB9E6CB)

/*
 * Dark mode inverts which end of the green carries text. The light theme's green is too
 * dark to sit on a near-black surface — as a button fill it reads as a hole, and as text
 * it fails contrast — so the hue is lifted until it carries, and the label on top of that
 * lighter fill has to be dark rather than the white the light theme uses.
 */
private val NightGreen = Color(0xFF7FD1A4)
private val NightGreenDark = Color(0xFF04150C)
private val NightGreenContainer = Color(0xFF1F4A34)

private val Light = lightColorScheme(
    primary = Green,
    onPrimary = Color.White,
    primaryContainer = GreenContainer,
    onPrimaryContainer = GreenDark,
    secondary = Green,
    onSecondary = Color.White,
)

private val Dark = darkColorScheme(
    primary = NightGreen,
    onPrimary = NightGreenDark,
    primaryContainer = NightGreenContainer,
    onPrimaryContainer = Color.White,
    secondary = NightGreen,
    onSecondary = NightGreenDark,
)

@Composable
fun UnbentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        content = content,
    )
}
