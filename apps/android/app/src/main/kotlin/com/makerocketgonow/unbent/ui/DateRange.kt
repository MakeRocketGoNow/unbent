package com.makerocketgonow.unbent.ui

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import com.makerocketgonow.unbent.R

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

/**
 * The ranges people ask for by name, as a start day with no end.
 *
 * Open-ended on purpose: "the last 7 days" means "since a week ago", and pinning an end
 * to today would make the filter wrong the moment midnight passed with the sheet still
 * open. The server's range is inclusive at both ends, so an absent end means "up to now"
 * and keeps meaning it.
 *
 * The day is taken in the device's zone rather than UTC, unlike everything else in this
 * file. That is deliberate and it is the one place the distinction runs the other way:
 * these presets answer a question about the user's own calendar — "today", "this year" —
 * so the boundary has to be their midnight. The result is still a plain `YYYY-MM-DD`,
 * which the API reads in UTC as a calendar date, so nothing downstream sees a zone.
 */
enum class DatePreset(val label: Int, private val days: Long?) {
    TODAY(R.string.dates_today, 0),
    WEEK(R.string.dates_7, 7),
    MONTH(R.string.dates_30, 30),
    QUARTER(R.string.dates_90, 90),
    YEAR(R.string.dates_year, null),
    ;

    /** The first day of this range, as the API's day string. */
    fun from(today: LocalDate = LocalDate.now()): String =
        when (days) {
            // A null span means the calendar year rather than a rolling window.
            null -> today.withDayOfYear(1)
            else -> today.minusDays(days)
        }.toString()
}
