package com.makerocketgonow.unbent.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/**
 * The spacing and shape vocabulary, so the phone reads as deliberately as the site does.
 *
 * The screens here grew one at a time and each picked its own numbers: the drawer alone
 * used four different horizontal insets and five vertical gaps, which is what "the styles
 * aren't as tight as the web" describes. A step scale fixes that by leaving fewer choices:
 * a gap is one of these or it is wrong.
 *
 * The steps are 4dp multiples because Material's own components are built on that grid;
 * anything off it sits half a pixel out of line with the padding Compose already applies
 * inside a ListItem or a Chip.
 */
object Space {
    /** Between a label and the thing it labels. Tighter than [Small] on purpose. */
    val Hair = 4.dp

    /** Within a group: chip to chip, icon to text. */
    val Small = 8.dp

    /** Between rows of different things, and around a section's contents. */
    val Medium = 12.dp

    /** The standard screen inset, and the gap between sections. */
    val Large = 16.dp

    /** Around a screen that is mostly one column of text: settings, empty states. */
    val Screen = 24.dp

    /**
     * Clearance under a scrolling list for the FAB, which floats over the last row.
     * Not a step: it is the FAB's 56dp plus its 16dp margin, and follows that if it moves.
     */
    val FabClearance = 88.dp
}

/**
 * Corner radii, reconciled with the web.
 *
 * The web uses fully round ends for anything carrying a count or a tag name and ~0.4rem
 * for the boxes those sit in. Material's defaults are squarer than that, and following
 * them everywhere would make the two apps look like different products, but adopting the
 * web's radii wholesale would make the phone look like a web page, which is the other
 * failure. The split: pills stay pills, because that shape is the brand and Material's own
 * chips and badges are pill-shaped anyway; containers stay on Material's scale, because a
 * sheet or a dialog with web radii reads as foreign on Android.
 */
object Shapes {
    /** Tag chips and count badges. Round ends, as on the web. */
    val Pill = RoundedCornerShape(percent = 50)

    /** Rows that highlight when selected: drawer items, list rows. */
    val Row = RoundedCornerShape(12.dp)
}
