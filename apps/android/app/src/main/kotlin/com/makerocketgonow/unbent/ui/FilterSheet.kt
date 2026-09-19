package com.makerocketgonow.unbent.ui

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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.FieldDef
import com.makerocketgonow.unbent.api.FieldFilter
import com.makerocketgonow.unbent.api.UNFILED
import com.makerocketgonow.unbent.ui.theme.Shapes
import com.makerocketgonow.unbent.ui.theme.Space

/**
 * Which filter the sheet is showing. The root lists them; the rest are one level down.
 *
 * A single sheet that swaps its contents rather than a stack of sheets: a sheet opening
 * over a sheet dims the first one behind the second and leaves two scrims on screen, and
 * on the way back out the phone's back gesture has to unwind both.
 */
private enum class FilterPage { ROOT, TAGS, FIELDS, DATES }

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
                onFields = { page = FilterPage.FIELDS },
                onDates = { page = FilterPage.DATES },
                onDone = onDismiss,
            )

            FilterPage.TAGS -> TagPicker(state = state, onBack = { page = FilterPage.ROOT })

            FilterPage.FIELDS -> FieldsPicker(state = state, onBack = { page = FilterPage.ROOT })

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
    onFields: () -> Unit,
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
                for (raw in state.fieldFilters) {
                    FilterChipRemovable(fieldFilterLabel(raw, state.fieldDefs)) {
                        state.filterByFields(state.fieldFilters - raw)
                    }
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
        /*
         * Fields, between tags and dates, and only inside a notebook that defines any.
         * Field definitions belong to a notebook, so outside one there is nothing to
         * offer, and a row that opened onto an empty page would be a control that does
         * nothing. The value counts filters rather than naming them: the chips above
         * already name them, and a row has one line. The web's sheet has the same row.
         */
        if (state.fieldDefs.isNotEmpty()) {
            FilterRow(
                icon = { Icon(painterResource(R.drawable.ic_sliders), contentDescription = null) },
                label = stringResource(R.string.fields_label),
                value = state.fieldFilters.takeIf { it.isNotEmpty() }?.let {
                    pluralStringResource(R.plurals.fields_selected, it.size, it.size)
                },
                onClick = onFields,
            )
        }
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
 * Narrow the list by the selected notebook's fields: a control per definition.
 *
 * A select, a checkbox and the text-like types get a row of chips — "Any", the values it
 * can equal, then whether it is set or empty at all. A number gets a pair of bounds and a
 * date a pair of days, either end open, the way the date range's custom fields work: a
 * range is two values, and a page that closed after the first would take the second away
 * mid-edit. Text "contains" is not offered; the search box already reads field values.
 *
 * Every change writes the filter at once, as the dates page does; there is no Apply. The
 * chips on the root and the title's second line report what is set, so a change is
 * visible the moment it is made. The rows are the definitions, not the filters: a page
 * listing only what is set would have nothing on it the first time, which is when it is
 * opened. The web's Fields page is the same shape.
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun FieldsPicker(state: NotesState, onBack: () -> Unit) {
    val current = remember(state.fieldFilters) { state.fieldFilters.mapNotNull(FieldFilter::parse) }

    /** Replaces this field's filters of the given ops with `next`, keeping everything else. */
    fun write(fieldId: String, ops: Set<FieldFilter.Op>, next: List<FieldFilter>) {
        val kept = current.filter { !(it.fieldId == fieldId && it.op in ops) }
        state.filterByFields((kept + next).map(FieldFilter::format))
    }

    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Space.Screen)
            .padding(bottom = Space.Screen),
    ) {
        PickerHeader(stringResource(R.string.fields_label), onBack)

        for (def in state.fieldDefs) {
            val mine = current.filter { it.fieldId == def.id }
            Text(
                def.name,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Space.Medium, bottom = Space.Small),
            )
            when (def.type) {
                "number" -> NumberBounds(def, mine, ::write)
                "date" -> DateBounds(def, mine, ::write)
                else -> ChoiceChips(def, mine, ::write)
            }
        }
    }
}

private typealias WriteFilter = (fieldId: String, ops: Set<FieldFilter.Op>, next: List<FieldFilter>) -> Unit

private val CHOICE_OPS = setOf(FieldFilter.Op.EQ, FieldFilter.Op.SET, FieldFilter.Op.EMPTY, FieldFilter.Op.GTE, FieldFilter.Op.LTE)

/**
 * The ways a select, multi-select, checkbox or text-like field can be narrowed, as one row
 * of chips. A multi-select's chips are its options too: `eq` on one means "holds it".
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun ChoiceChips(def: FieldDef, mine: List<FieldFilter>, write: WriteFilter) {
    val one = mine.firstOrNull()
    val choices: List<Pair<String, FieldFilter?>> = buildList {
        add(stringResource(R.string.field_any) to null)
        when (def.type) {
            "select", "multiselect" -> for (o in def.options) add(o to FieldFilter(def.id, FieldFilter.Op.EQ, o))
            "checkbox" -> {
                add(stringResource(R.string.field_checked) to FieldFilter(def.id, FieldFilter.Op.EQ, "true"))
                add(stringResource(R.string.field_unchecked) to FieldFilter(def.id, FieldFilter.Op.EQ, "false"))
            }
        }
        add(stringResource(R.string.field_set) to FieldFilter(def.id, FieldFilter.Op.SET))
        add(stringResource(R.string.field_empty) to FieldFilter(def.id, FieldFilter.Op.EMPTY))
    }
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(Space.Small),
        verticalArrangement = Arrangement.spacedBy(Space.Small),
    ) {
        for ((label, filter) in choices) {
            FilterChip(
                selected = one == filter,
                onClick = { write(def.id, CHOICE_OPS, listOfNotNull(filter)) },
                shape = Shapes.Pill,
                label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            )
        }
    }
}

/**
 * A number's two bounds, either end open.
 *
 * Written when the field is left or Done is pressed rather than on every keystroke: a
 * bound typed as "20" would otherwise reload the list at "2" on the way, and a filter
 * that flickers through values nobody asked for is worse than one that waits a beat.
 */
@Composable
private fun NumberBounds(def: FieldDef, mine: List<FieldFilter>, write: WriteFilter) {
    Row(horizontalArrangement = Arrangement.spacedBy(Space.Medium)) {
        for (op in listOf(FieldFilter.Op.GTE, FieldFilter.Op.LTE)) {
            val applied = mine.firstOrNull { it.op == op }?.value.orEmpty()
            var draft by rememberSaveable(applied) { mutableStateOf(applied) }
            val commit = {
                val trimmed = draft.trim()
                if (trimmed != applied) {
                    write(def.id, setOf(op), listOfNotNull(FieldFilter.parse("${def.id}:${op.wire}:$trimmed")))
                }
            }
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                label = { Text(stringResource(if (op == FieldFilter.Op.GTE) R.string.field_min else R.string.field_max)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { commit() }),
                shape = Shapes.Row,
                modifier = Modifier
                    .weight(1f)
                    .onFocusChanged { if (!it.isFocused) commit() },
            )
        }
    }
}

/** A date's two bounds, each a day picked from a calendar; a picked day can be cleared. */
@Composable
private fun DateBounds(def: FieldDef, mine: List<FieldFilter>, write: WriteFilter) {
    var picking by rememberSaveable { mutableStateOf<FieldFilter.Op?>(null) }
    Row(horizontalArrangement = Arrangement.spacedBy(Space.Medium)) {
        for (op in listOf(FieldFilter.Op.GTE, FieldFilter.Op.LTE)) {
            val applied = mine.firstOrNull { it.op == op }?.value
            val caption = stringResource(if (op == FieldFilter.Op.GTE) R.string.field_from else R.string.field_to)
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    onClick = { picking = op },
                    shape = Shapes.Row,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        applied?.let { runCatching { formatDay(it) }.getOrDefault(it) } ?: caption,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (applied != null) {
                    IconButton(onClick = { write(def.id, setOf(op), emptyList()) }) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = stringResource(R.string.field_bound_clear, caption),
                        )
                    }
                }
            }
        }
    }
    picking?.let { op ->
        DayPickerDialog(
            initial = mine.firstOrNull { it.op == op }?.value,
            onDismiss = { picking = null },
            onPick = { day ->
                picking = null
                write(def.id, setOf(op), listOf(FieldFilter(def.id, op, day)))
            },
        )
    }
}

/** One day from the calendar, as the API's `YYYY-MM-DD`; the conversions are DateRange.kt's. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DayPickerDialog(initial: String?, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val picker = rememberDatePickerState(initialSelectedDateMillis = initial?.let(::dayMillis))
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                enabled = picker.selectedDateMillis != null,
                onClick = { picker.selectedDateMillis?.let { onPick(utcDay(it)) } },
            ) {
                Text(stringResource(R.string.dates_apply))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) }
        },
    ) {
        DatePicker(state = picker)
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
