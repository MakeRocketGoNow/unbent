package com.makerocketgonow.unbent.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.ui.theme.Space

/**
 * One notebook to pick, with its note count where it has one; the Inbox has none.
 *
 * A row in a list rather than an entry in a dropdown, on purpose: the note screen's
 * filing sheet and the capture sheet both show notebooks this way, and a list inside the
 * sheet needs no popup window — which matters in the share activity, where popups and
 * dialogs proved unreliable over a translucent window.
 */
@Composable
fun NotebookChoice(name: String, count: Int?, selected: Boolean, onSelect: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onSelect).padding(vertical = Space.Hair),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(name, modifier = Modifier.weight(1f))
        if (count != null) {
            Text(
                count.toString(),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
