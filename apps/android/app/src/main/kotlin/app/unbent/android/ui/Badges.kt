package app.unbent.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import app.unbent.android.ui.theme.Shapes
import app.unbent.android.ui.theme.Space

/**
 * A count, drawn the same way everywhere one appears.
 *
 * Counts are the drawer's whole point — in an archive this size "Dentist 22" is the
 * information — so they had been written inline wherever they were needed and drifted:
 * a bare label in one place, part of a chip's own text in another. One composable means
 * one size, one radius, one colour.
 *
 * Deliberately quiet. The count qualifies the name beside it; a badge loud enough to
 * compete with the name turns a directory into a scoreboard.
 */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    Text(
        count.toString(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier,
    )
}

/**
 * A tag, drawn the same way everywhere one appears.
 *
 * The app had three tag presentations — an InputChip on the note, a SuggestionChip under
 * the field, and a FilterChip in the drawer whose count was concatenated into its label
 * as "name 12". They were three sizes and two shapes for one concept. This is the filter
 * form: selectable, with the count as a real trailing element rather than text glued to
 * the name, so it can be styled — and dimmed while selected, where the chip's own
 * container already carries the emphasis.
 */
@Composable
fun TagChip(
    name: String,
    count: Int?,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        shape = Shapes.Pill,
        label = {
            Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        trailingIcon = count?.let {
            {
                Text(
                    it.toString(),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (selected) {
                        MaterialTheme.colorScheme.onSecondaryContainer
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        },
        modifier = modifier,
    )
}
