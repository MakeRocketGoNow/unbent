package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.ui.When
import com.makerocketgonow.unbent.ui.whenOf
import org.junit.Assert.assertEquals
import org.junit.Test

/** The same thresholds as the web's format-when.ts, so the two lists agree. */
class FormatWhenTest {
    private val now = 1_700_000_000_000L
    private val minute = 60_000L

    @Test
    fun `under a minute is just now`() {
        assertEquals(When.JustNow, whenOf(now - 59_000, now))
    }

    @Test
    fun `minutes, then hours, each floored`() {
        assertEquals(When.MinutesAgo(1), whenOf(now - minute, now))
        assertEquals(When.MinutesAgo(59), whenOf(now - 59 * minute, now))
        assertEquals(When.HoursAgo(1), whenOf(now - 60 * minute, now))
        assertEquals(When.HoursAgo(23), whenOf(now - (23 * 60 + 59) * minute, now))
    }

    @Test
    fun `a day or more is the date itself`() {
        val then = now - 24 * 60 * minute
        assertEquals(When.On(then), whenOf(then, now))
    }
}
