package app.unbent.android

import app.unbent.android.ui.dayMillis
import app.unbent.android.ui.formatDay
import app.unbent.android.ui.utcDay
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The day the picker gives is the day the API gets, whatever zone the phone is in.
 *
 * Pinned in a zone west of Greenwich because that is where the mistake shows: midnight
 * UTC is the previous evening there, and a conversion through the device zone sends the
 * day before the one picked.
 */
class DateRangeTest {

    private fun <T> inZone(id: String, block: () -> T): T {
        val original = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone(id))
        try {
            return block()
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test
    fun `a picker's millis become the API's day through UTC, not the phone's zone`() = inZone("America/Los_Angeles") {
        assertEquals("2023-01-01", utcDay(1672531200000L))
        assertEquals(1672531200000L, dayMillis("2023-01-01"))
        assertEquals("2023-12-31", utcDay(dayMillis("2023-12-31")))
    }

    @Test
    fun `a day is shown as a date, not an instant`() = inZone("America/Los_Angeles") {
        assertEquals("Jan 1, 2023", formatDay("2023-01-01", Locale.US))
    }
}
