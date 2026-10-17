package com.makerocketgonow.unbent.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.SuggestionChipDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.Tag
import com.makerocketgonow.unbent.ui.theme.Space
import com.makerocketgonow.unbent.ui.theme.TagColors

/**
 * The note's tags: the ones it has as chips, a field to add one, and the account's other
 * tags as suggestions narrowed by what has been typed.
 *
 * The capture sheet's; the app's other screens are the site's now. Suggestions matter
 * more than free typing here: an archive's tags are a vocabulary, and "Dentist" typed as
 * "dentist" is a second tag the web's case-variant cleanup later has to fold back in.
 *
 * The field's text belongs to the caller, not to this editor, because the caller is the
 * one with a Save or Done button: a tag still being typed when that button is tapped has
 * to go with it. See [tagsWithDraft].
 *
 * Each chip wears the colour the server stored on its tag ([Tag.color], through
 * [TagColors]), found by name without case as the server finds a tag, so a chip here is
 * the chip the site draws for the same tag. A tag typed here that the account does not
 * have yet has no row and no colour, and is drawn neutral until the server gives it one.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagEditor(
    tags: List<String>,
    /** What has been typed into the field and not yet added. */
    draft: String,
    suggestions: List<Tag>,
    onChange: (List<String>) -> Unit,
    onDraftChange: (String) -> Unit,
) {
    fun add(raw: String) {
        onChange(tagsWithDraft(tags, raw))
        onDraftChange("")
    }

    val colorOf = suggestions.associate { it.name.lowercase() to it.color }
    val dark = isSystemInDarkTheme()
    val surface = MaterialTheme.colorScheme.surface
    val onSurface = MaterialTheme.colorScheme.onSurface
    fun fill(tag: String) = TagColors.fill(colorOf[tag.lowercase()], surface, onSurface, dark)
    fun ink(tag: String) = TagColors.ink(colorOf[tag.lowercase()], onSurface, dark)

    Column {
        if (tags.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.Small)) {
                for (tag in tags) {
                    InputChip(
                        selected = false,
                        onClick = { onChange(tags - tag) },
                        label = { Text(tag) },
                        trailingIcon = {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.remove_tag, tag))
                        },
                        // The wash is the chip's edge, as on the site: no outline on top of it.
                        border = null,
                        colors = InputChipDefaults.inputChipColors(
                            containerColor = fill(tag),
                            labelColor = ink(tag),
                            trailingIconColor = ink(tag),
                        ),
                    )
                }
            }
        }
        OutlinedTextField(
            value = draft,
            onValueChange = onDraftChange,
            placeholder = { Text(stringResource(R.string.add_tag)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { add(draft) }),
            modifier = Modifier.fillMaxWidth(),
        )
        val offered = suggestions
            .filter { s -> tags.none { it.equals(s.name, ignoreCase = true) } }
            .filter { draft.isBlank() || it.name.contains(draft.trim(), ignoreCase = true) }
            .take(12)
        if (offered.isNotEmpty()) {
            Spacer(Modifier.height(Space.Small))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.Small)) {
                for (s in offered) {
                    SuggestionChip(
                        onClick = { add(s.name) },
                        label = { Text(s.name) },
                        border = null,
                        colors = SuggestionChipDefaults.suggestionChipColors(
                            containerColor = fill(s.name),
                            labelColor = ink(s.name),
                        ),
                    )
                }
            }
        }
    }
}

/**
 * The tags with whatever is still in the field added on.
 *
 * The keyboard's Done key adds a typed tag, but nobody owes the field that key. On an
 * account with no tags yet there are no chips to tap, so typing is the only way in, and
 * the natural gesture is to type the word and tap Save. A sheet that drops it on the way
 * out has lost the one piece of filing the person did by hand, and says nothing, since
 * the note still saves. Every button that leaves a sheet runs its tags through here.
 */
fun tagsWithDraft(tags: List<String>, draft: String): List<String> {
    val tag = draft.trim()
    if (tag.isEmpty() || tags.any { it.equals(tag, ignoreCase = true) }) return tags
    return tags + tag
}
