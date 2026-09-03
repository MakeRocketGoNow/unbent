package app.unbent.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.unbent.android.R
import app.unbent.android.api.UNFILED
import app.unbent.android.ui.theme.Shapes
import app.unbent.android.ui.theme.Space

/**
 * Which filter the sheet is showing. The root lists them; the rest are one level down.
 *
 * A single sheet that swaps its contents rather than a stack of sheets: a sheet opening
 * over a sheet dims the first one behind the second and leaves two scrims on screen, and
 * on the way back out the phone's back gesture has to unwind both.
 */
private enum class FilterPage { ROOT, TAGS, DATES }

/**
 * Everything that narrows the list, in one place.
 *
 * The filters had ended up spread across three surfaces — the notebook in the drawer, the
 * tags in a sheet off it, the dates in the app bar's overflow — so "what am I looking at"
 * had no single answer and turning a filter off meant remembering where it had been set.
 * They are one kind of thing and they belong together.
 *
 * The notebook is the exception and stays in the drawer, because it is the app's primary
 * navigation rather than a filter people toggle: it is how you get somewhere, and the
 * drawer is a better place to browse a hundred notebooks than a row in a sheet. It still
 * appears here as a chip, because a surface claiming to show what is applied has to show
 * all of it — but it is removed here rather than chosen here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilterSheet(state: NotesState, onDismiss: () -> Unit) {
    var page by rememberSaveable { mutableStateOf(FilterPage.ROOT) }
    var pickingCustomRange by rememberSaveable { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        when (page) {
            FilterPage.ROOT -> FilterRoot(
                state = state,
                onTags = { page = FilterPage.TAGS },
                onDates = { page = FilterPage.DATES },
                onDone = onDismiss,
            )

            FilterPage.TAGS -> TagPicker(state = state, onBack = { page = FilterPage.ROOT })

            FilterPage.DATES -> DatePicker(
                state = state,
                onBack = { page = FilterPage.ROOT },
                onCustom = { pickingCustomRange = true },
            )
        }
    }

    if (pickingCustomRange) {
        DateRangeDialog(
            from = state.from,
            to = state.to,
            onDismiss = { pickingCustomRange = false },
            onPick = { from, to ->
                pickingCustomRange = false
                state.dateRange(from, to)
                page = FilterPage.ROOT
            },
        )
    }
}

/**
 * The applied filters as chips, then a row per filter.
 *
 * The chips are the point of the sheet. Before them the only record of what was applied
 * was the app bar's title, which could say a filter was on but offered no way to take it
 * off — the user had to remember which surface had set it. Every chip carries its own ×,
 * so removing one filter never means going to find where it came from.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterRoot(
    state: NotesState,
    onTags: () -> Unit,
    onDates: () -> Unit,
    onDone: () -> Unit,
) {
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Space.Screen)
            .padding(bottom = Space.Screen),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.filter_notes),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            // Only offered when it would do something. A permanently visible "Clear all"
            // on an unfiltered list is a button that promises an effect it cannot have.
            if (state.filtered) {
                TextButton(onClick = { state.clearFilters() }) {
                    Text(stringResource(R.string.filter_clear_all))
                }
            }
        }

        Spacer(Modifier.height(Space.Medium))

        if (state.filtered) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(Space.Small),
                verticalArrangement = Arrangement.spacedBy(Space.Small),
            ) {
                val notebook = state.notebook
                if (notebook != null) {
                    val label =
                        if (notebook == UNFILED) stringResource(R.string.inbox) else notebook
                    FilterChipRemovable(label) { state.filterBy(notebook = null, tags = state.selectedTags) }
                }
                for (tag in state.selectedTags) {
                    FilterChipRemovable("#$tag") { state.toggleTag(tag) }
                }
                val range = rangeLabel(state.from, state.to)
                if (range != null) {
                    FilterChipRemovable(range) { state.dateRange(null, null) }
                }
            }
        } else {
            Text(
                stringResource(R.string.filter_none),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(Space.Large))
        HorizontalDivider()

        FilterRow(
            icon = { Icon(painterResource(R.drawable.ic_tag), contentDescription = null) },
            label = stringResource(R.string.tags_label),
            value = state.selectedTags.takeIf { it.isNotEmpty() }?.let {
                pluralStringResource(R.plurals.tags_selected, it.size, it.size)
            },
            onClick = onTags,
        )
        FilterRow(
            icon = { Icon(Icons.Default.DateRange, contentDescription = null) },
            label = stringResource(R.string.dates_label),
            value = rangeLabel(state.from, state.to),
            onClick = onDates,
        )

        Spacer(Modifier.height(Space.Large))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onDone) { Text(stringResource(R.string.done)) }
        }
    }
}

/** One filter: what it is, what it is set to, and a chevron saying it opens. */
@Composable
private fun FilterRow(
    icon: @Composable () -> Unit,
    label: String,
    value: String?,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = Space.Medium),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon()
        Text(label, modifier = Modifier.padding(start = Space.Medium).weight(1f))
        if (value != null) {
            Text(
                value,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = Space.Small),
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** An applied filter, with the × that takes it off. */
@Composable
private fun FilterChipRemovable(label: String, onRemove: () -> Unit) {
    InputChip(
        selected = true,
        onClick = onRemove,
        shape = Shapes.Pill,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingIcon = {
            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.filter_remove, label))
        },
    )
}

/**
 * The tags, searchable, most-used first.
 *
 * A search field because this is not a list anyone scrolls: a real archive has hundreds of
 * tags, and half of them sit on three notes or fewer. The server orders them by use, so
 * the tags worth filtering by are the ones on screen before a key is pressed, and typing
 * is how the tail is reached rather than the only way through.
 *
 * A LazyColumn rather than the chip cloud the sheet used to show, because a cloud of three
 * hundred chips cannot be scanned and its rows do not align. Selected tags stay in place
 * as they are tapped rather than jumping to the top: a list that reorders under the finger
 * makes the second tap land on something the user did not aim at.
 */
@Composable
private fun TagPicker(state: NotesState, onBack: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val matches = remember(state.tags, query) {
        val needle = query.trim()
        if (needle.isEmpty()) state.tags
        else state.tags.filter { it.name.contains(needle, ignoreCase = true) }
    }

    Column(
        Modifier
            .padding(horizontal = Space.Screen)
            .padding(bottom = Space.Screen),
    ) {
        PickerHeader(stringResource(R.string.tags_label), onBack)

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text(stringResource(R.string.tags_find)) },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            shape = Shapes.Row,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(Space.Medium))

        if (matches.isEmpty()) {
            Text(
                stringResource(R.string.tags_no_matches),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            /*
             * Bounded so the sheet cannot grow past the screen on an account with hundreds
             * of tags, and so the field above stays visible while the list is scrolled —
             * a search field that scrolls away is a search field you cannot correct.
             */
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(matches, key = { it.name }) { tag ->
                    TagRow(
                        name = tag.name,
                        count = tag.count,
                        selected = tag.name in state.selectedTags,
                        onClick = { state.toggleTag(tag.name) },
                    )
                }
            }
        }
    }
}

/**
 * One tag: the chip, then its count.
 *
 * A full-width row rather than a cloud, because the names are unbounded — this archive has
 * tags like "20806 Greenwood Ave" — and chips at mixed widths cannot be scanned down. The
 * count sits just after the chip rather than pinned to the far edge: on a phone that put
 * a number a hand's width from the name it belonged to, with nothing between them.
 *
 * The whole row is the target, not just the chip, so a short name is no harder to hit
 * than a long one.
 */
@Composable
private fun TagRow(name: String, count: Int, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = Space.Hair),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TagChip(name = name, count = null, selected = selected, onClick = onClick)
        Spacer(Modifier.width(Space.Medium))
        CountBadge(count)
    }
}

/**
 * The date range: the ranges people actually ask for, then the calendar.
 *
 * Presets first because "the last week" is the common question and answering it through a
 * two-ended calendar picker means two taps on the right days plus the arithmetic to know
 * which days those are. The custom range is still there for the archive question — "what
 * did I file in 2014" — which no preset can express.
 */
@Composable
private fun DatePicker(state: NotesState, onBack: () -> Unit, onCustom: () -> Unit) {
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Space.Screen)
            .padding(bottom = Space.Screen),
    ) {
        PickerHeader(stringResource(R.string.dates_label), onBack)

        for (preset in DatePreset.entries) {
            val from = preset.from()
            PresetRow(
                label = stringResource(preset.label),
                selected = state.from == from && state.to == null,
                onClick = {
                    // Open-ended: a preset means "since then", so today never needs naming
                    // and the range does not go stale overnight.
                    state.dateRange(from, null)
                    onBack()
                },
            )
        }

        PresetRow(
            label = stringResource(R.string.dates_any),
            selected = state.from == null && state.to == null,
            onClick = {
                state.dateRange(null, null)
                onBack()
            },
        )
        PresetRow(label = stringResource(R.string.dates_custom), selected = false, onClick = onCustom)
    }
}

@Composable
private fun PresetRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = Space.Medium),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            color = if (selected) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurface
            },
            modifier = Modifier.weight(1f),
        )
        // A check, not a ×. This marks which range is in force, and on "Any time" — the
        // row that means no range at all — a × would read as an offer to remove something
        // that is not there.
        if (selected) {
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/** A sub-page's title and the way back to the list of filters. */
@Composable
private fun PickerHeader(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = onBack) { Text(stringResource(R.string.done)) }
    }
    Spacer(Modifier.height(Space.Small))
}
