package app.unbent.android.ui

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The date-range filter's conversions, and the trap between them.
 *
 * The API takes days as `YYYY-MM-DD` and reads them in UTC. Material's date pickers hand
 * back, and take, milliseconds at UTC midnight. So a day goes to the picker and comes back
 * through UTC explicitly, never through the device zone: the phone's own zone would turn
 * midnight UTC into the previous evening anywhere west of Greenwich, and a range picked
 * as the 1st would be sent as the 31st.
 *
 * Showing a day has no zone in it at all — a LocalDate is a calendar date, not an instant —
 * which is why `FormatWhen`'s device-zone formatter is not used here. It formats instants,
 * and for a UTC midnight it would print the day before.
 */

/** The API's day for a picker's millis. */
fun utcDay(millis: Long): String =
    Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()

/** A picker's millis for the API's day. */
fun dayMillis(day: String): Long =
    LocalDate.parse(day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

/** The day as people read it: "Jan 1, 2023" in the US, "1 Jan 2023" in the UK. */
fun formatDay(day: String, locale: Locale = Locale.getDefault()): String =
    LocalDate.parse(day).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
