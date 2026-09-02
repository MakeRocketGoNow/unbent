package app.unbent.android.ui

import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import app.unbent.android.R
import java.util.Date

/**
 * When something happened, as the note list says it. Mirrors `format-when.ts` on the web:
 * relative within a day, a plain date past that, because "3 weeks ago" is less useful
 * than the date for an archive that spans years.
 */
sealed interface When {
    data object JustNow : When
    data class MinutesAgo(val minutes: Long) : When
    data class HoursAgo(val hours: Long) : When
    data class On(val ms: Long) : When
}

fun whenOf(ms: Long, now: Long = System.currentTimeMillis()): When {
    val minutes = (now - ms) / 60_000
    if (minutes < 1) return When.JustNow
    if (minutes < 60) return When.MinutesAgo(minutes)
    val hours = minutes / 60
    if (hours < 24) return When.HoursAgo(hours)
    return When.On(ms)
}

@Composable
fun formatWhen(ms: Long): String = when (val w = whenOf(ms)) {
    When.JustNow -> stringResource(R.string.just_now)
    is When.MinutesAgo -> stringResource(R.string.minutes_ago, w.minutes)
    is When.HoursAgo -> stringResource(R.string.hours_ago, w.hours)
    // The device's own short date format, as `toLocaleDateString` is the browser's.
    is When.On -> DateFormat.getDateFormat(LocalContext.current).format(Date(w.ms))
}
