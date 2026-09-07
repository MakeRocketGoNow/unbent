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
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.unit.Dp
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
 * The tags: what is chosen, a field to narrow by, and the vocabulary to choose from.
 *
 * Laid out like [TagEditor], which is the same act on a note — chosen tags as removable
 * chips above the field, candidates below it. Two pickers for one concept had drifted into
 * two shapes, and the editor's own reasoning applies here just as well: a tag is chosen
 * the same way wherever it is chosen.
 *
 * Chips above the field rather than ticks down the list because a selection has to stay
 * visible. Sorted by use, a rare tag sits hundreds of rows down; select it, scroll away
 * looking for a second, and the first is gone from the screen with no way to see or remove
 * it but to find it again. Above the field it is always both.
 *
 * A search field because this is not a list anyone scrolls: a real archive has hundreds of
 * tags, and half sit on three notes or fewer. The server orders them by use, so the tags
 * worth filtering by are on screen before a key is pressed, and typing is how the tail is
 * reached rather than the only way through.
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun TagPicker(state: NotesState, onBack: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val selected = state.selectedTags
    /*
     * Chosen tags leave the list below: they are already on screen as chips, and a name in
     * two places at once invites tapping the one that does not remove it. This is what
     * TagEditor does with its own suggestions, for the same reason.
     */
    val matches = remember(state.tags, query, selected) {
        val needle = query.trim()
        state.tags
            .filter { it.name !in selected }
            .filter { needle.isEmpty() || it.name.contains(needle, ignoreCase = true) }
    }

    Column(
        Modifier
            .padding(horizontal = Space.Screen)
            .padding(bottom = Space.Screen),
    ) {
        PickerHeader(stringResource(R.string.tags_label), onBack)

        if (selected.isNotEmpty()) {
            /*
             * Capped and scrollable rather than growing without limit. A note carries a
             * handful of tags, so TagEditor can let its row grow; a filter can plausibly
             * carry eight, and in a sheet every row they add is a row taken from the list
             * being chosen from.
             */
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(Space.Small),
                verticalArrangement = Arrangement.spacedBy(Space.Small),
                modifier = Modifier
                    .heightIn(max = 112.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                for (tag in selected) {
                    InputChip(
                        selected = true,
                        onClick = { state.toggleTag(tag) },
                        shape = Shapes.Pill,
                        label = { Text(tag, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        trailingIcon = {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = stringResource(R.string.remove_tag, tag),
                            )
                        },
                    )
                }
            }
            Spacer(Modifier.height(Space.Medium))
        }

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
                stringResource(
                    // "No tags match" is wrong when the vocabulary is simply exhausted:
                    // with everything chosen there is nothing left to offer, and nothing
                    // the user typed is at fault.
                    if (query.isBlank()) R.string.tags_all_chosen else R.string.tags_no_matches,
                ),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            /*
             * Bounded so the sheet cannot grow past the screen on an account with hundreds
             * of tags, and so the field above stays visible while the list is scrolled —
             * a search field that scrolls away is a search field you cannot correct.
             */
            LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(matches, key = { it.name }) { tag ->
                    TagRow(
                        name = tag.name,
                        count = tag.count,
                        onClick = { state.toggleTag(tag.name) },
                    )
                }
            }
        }
    }
}

/**
 * One tag on offer: the chip, then how many notes carry it.
 *
 * A full-width row rather than a cloud, because the names are unbounded — this archive has
 * tags like "20806 Greenwood Ave" — and chips at mixed widths cannot be scanned down. The
 * count sits just after the chip rather than pinned to the far edge: on a phone that put a
 * number a hand's width from the name it belonged to, with nothing between them.
 *
 * The count is the reason to keep this a row at all. On an archive where one tag has three
 * hundred notes and the next has one, the number is most of what tells them apart, and a
 * picker without it makes the choice blind.
 *
 * Never drawn selected: a chosen tag is a chip above the field instead, so this row always
 * means "add this one". The whole row is the target, not just the chip, so a short name is
 * no harder to hit than a long one.
 */
@Composable
private fun TagRow(name: String, count: Int, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = Space.Hair),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        /*
         * The chip drops its own 48dp touch target here. Material gives every chip one
         * whether or not the chip is the thing being tapped, and here it is not — the row
         * is. Left on, a 32dp chip reserved 48dp and the rows sat 56dp apart: more empty
         * space between two tag names than either name occupied.
         *
         * What is left is a 40dp row, which is a dense list row rather than the 48dp
         * default. Deliberate: this list is scanned far more often than it is tapped, the
         * names are the content, and the row is full-width, so the target stays easy to
         * hit even at 40dp.
         */
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides Dp.Unspecified) {
            TagChip(name = name, count = null, selected = false, onClick = onClick)
        }
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
