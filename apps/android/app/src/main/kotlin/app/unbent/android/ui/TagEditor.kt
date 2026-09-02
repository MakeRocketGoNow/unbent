package app.unbent.android.ui

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
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import app.unbent.android.R
import app.unbent.android.api.Tag

/**
 * The note's tags: the ones it has as chips, a field to add one, and the account's other
 * tags as suggestions narrowed by what has been typed.
 *
 * Shared by the note screen's filing sheet and the capture sheet, so a tag is entered the
 * same way wherever it is entered. Suggestions matter more than free typing here: an
 * archive's tags are a vocabulary, and "Dentist" typed as "dentist" is a second tag the
 * web's case-variant cleanup later has to fold back in.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagEditor(
    tags: List<String>,
    suggestions: List<Tag>,
    onChange: (List<String>) -> Unit,
) {
    var draft by rememberSaveable { mutableStateOf("") }

    fun add(raw: String) {
        val tag = raw.trim()
        if (tag.isNotEmpty() && tags.none { it.equals(tag, ignoreCase = true) }) {
            onChange(tags + tag)
        }
        draft = ""
    }

    Column {
        if (tags.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (tag in tags) {
                    InputChip(
                        selected = false,
                        onClick = { onChange(tags - tag) },
                        label = { Text(tag) },
                        trailingIcon = {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.remove_tag, tag))
                        },
                    )
                }
            }
        }
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
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
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (s in offered) {
                    SuggestionChip(onClick = { add(s.name) }, label = { Text(s.name) })
                }
            }
        }
    }
}
