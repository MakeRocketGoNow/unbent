package com.makerocketgonow.unbent.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.Notebook
import com.makerocketgonow.unbent.api.Tag
import com.makerocketgonow.unbent.api.UnbentApi
import com.makerocketgonow.unbent.share.StagedFile
import com.makerocketgonow.unbent.ui.theme.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The share sheet's own sheet: what was shared, where it goes, and one Save.
 *
 * Filing at the moment of capture is the habit that keeps an archive usable. A capture
 * that lands in the Inbox to be named and filed "later" is a triage job that gets skipped,
 * so the title, notebook and tags are here — prefilled, so the lazy case is still one tap.
 * The notebook offered first is wherever the last capture went, because shares come in
 * runs: five receipts in a row go to the same place.
 *
 * Signed out, the sheet says so and offers sign-in instead of the form. What was shared
 * is already staged on disk by then, so signing in and coming back finds it waiting.
 *
 * Drawn in the activity's own window rather than with Material's modal sheet, which puts
 * itself in a dialog window: inside a translucent activity whose only content is that
 * sheet, the dialog appeared seconds late and stopped half-expanded. A scrim and a
 * bottom-aligned surface here are the same picture with nothing between them and the
 * screen.
 */
@Composable
fun CaptureSheet(
    /** Null while signed out. */
    api: UnbentApi?,
    /** Null until the shared files have been copied into the app's cache. */
    staged: List<StagedFile>?,
    hasText: Boolean,
    initialTitle: String,
    lastNotebook: String?,
    onSignIn: () -> Unit,
    onSave: (title: String, notebook: String?, tags: List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    BackHandler { onDismiss() }

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f))
            // A tap on the scrim is a dismissal, as it is for any sheet.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
    ) {
        AnimatedVisibility(
            visible = shown,
            enter = slideInVertically { it },
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Surface(
                shape = RoundedCornerShape(topStart = Space.Screen, topEnd = Space.Screen),
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                modifier = Modifier
                    .fillMaxWidth()
                    // Taps on the sheet itself stay on the sheet rather than reaching the scrim.
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            ) {
                Column(
                    Modifier
                        .verticalScroll(rememberScrollState())
                        .navigationBarsPadding()
                        .imePadding()
                        .padding(horizontal = Space.Screen)
                        .padding(bottom = Space.Screen),
                ) {
                    DragHandle()
                    Text(stringResource(R.string.capture_title), style = MaterialTheme.typography.titleMedium)
                    Text(
                        summaryOf(staged, hasText),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(Space.Large))

                    if (api == null) {
                        SignedOut(onSignIn, onDismiss)
                    } else {
                        CaptureForm(api, staged, initialTitle, lastNotebook, onSave, onDismiss)
                    }
                }
            }
        }
    }
}

/** The pill Material draws on its sheets, so this one reads as the same kind of thing. */
@Composable
private fun DragHandle() {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(top = Space.Medium, bottom = Space.Large),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(width = Space.Screen, height = Space.Hair)
                .clip(RoundedCornerShape(Space.Hair))
                .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)),
        )
    }
}

@Composable
private fun SignedOut(onSignIn: () -> Unit, onDismiss: () -> Unit) {
    Text(stringResource(R.string.capture_sign_in), style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.height(Space.Large))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        Button(onClick = onSignIn) { Text(stringResource(R.string.sign_in_submit)) }
    }
}

@Composable
private fun CaptureForm(
    api: UnbentApi,
    staged: List<StagedFile>?,
    initialTitle: String,
    lastNotebook: String?,
    onSave: (String, String?, List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    // Keyed on the derived title so the field fills in once staging has named the share.
    // Staging takes well under a second; a person is not yet typing.
    var title by rememberSaveable(initialTitle) { mutableStateOf(initialTitle) }
    var notebook by rememberSaveable { mutableStateOf(lastNotebook) }
    var tags by remember { mutableStateOf<List<String>>(emptyList()) }
    var tagDraft by rememberSaveable { mutableStateOf("") }
    var notebooks by remember { mutableStateOf<List<Notebook>>(emptyList()) }
    var allTags by remember { mutableStateOf<List<Tag>>(emptyList()) }
    var picking by remember { mutableStateOf(false) }

    LaunchedEffect(api) {
        withContext(Dispatchers.IO) { runCatching { api.listNotebooks().notebooks } }.onSuccess { list ->
            notebooks = list
            // The remembered notebook may have been renamed or deleted since; the Inbox
            // is the honest fallback rather than a name the server would refuse.
            if (notebook != null && list.none { it.name == notebook }) notebook = null
        }
        withContext(Dispatchers.IO) { runCatching { api.listTags() } }.onSuccess { allTags = it }
    }

    OutlinedTextField(
        value = title,
        onValueChange = { title = it },
        label = { Text(stringResource(R.string.title_label)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(Space.Medium))

    // The field states the choice; tapping it unfolds the list beneath, inside the sheet.
    Box {
        OutlinedTextField(
            value = notebook ?: stringResource(R.string.inbox),
            onValueChange = {},
            readOnly = true,
            label = { Text(stringResource(R.string.notebook_label)) },
            trailingIcon = {
                Icon(
                    if (picking) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = null,
                )
            },
            modifier = Modifier.fillMaxWidth(),
        )
        // A read-only text field still takes the tap for itself; this layer takes it first.
        Box(
            Modifier
                .matchParentSize()
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                    picking = !picking
                },
        )
    }
    if (picking) {
        Column(Modifier.padding(top = Space.Hair)) {
            NotebookChoice(stringResource(R.string.inbox), null, notebook == null) {
                notebook = null
                picking = false
            }
            for (nb in notebooks) {
                NotebookChoice(nb.name, nb.count, notebook == nb.name) {
                    notebook = nb.name
                    picking = false
                }
            }
        }
    }
    Spacer(Modifier.height(Space.Medium))

    Text(
        stringResource(R.string.tags_label),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(Space.Hair))
    TagEditor(
        tags = tags,
        draft = tagDraft,
        suggestions = allTags,
        onChange = { tags = it },
        onDraftChange = { tagDraft = it },
    )
    Spacer(Modifier.height(Space.Large))

    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        Spacer(Modifier.padding(horizontal = Space.Hair))
        // Enabled once the files are safely in the cache: saving before that would enqueue
        // an upload of files that are not there yet. A tag still being typed goes too.
        Button(
            onClick = { onSave(title.trim(), notebook, tagsWithDraft(tags, tagDraft)) },
            enabled = staged != null,
        ) {
            Text(stringResource(R.string.capture_save))
        }
    }
}

/** "2 photos · 1 PDF", or "Text", or an ellipsis while the files are still being copied. */
@Composable
private fun summaryOf(staged: List<StagedFile>?, hasText: Boolean): String {
    if (staged == null) return "…"
    val photos = staged.count { it.contentType.startsWith("image/") }
    val pdfs = staged.count { it.contentType == "application/pdf" }
    val others = staged.size - photos - pdfs
    val parts = buildList {
        if (photos > 0) add(pluralStringResource(R.plurals.capture_photos, photos, photos))
        if (pdfs > 0) add(pluralStringResource(R.plurals.capture_pdfs, pdfs, pdfs))
        if (others > 0) add(pluralStringResource(R.plurals.capture_files, others, others))
        if (hasText && staged.isEmpty()) add(stringResource(R.string.capture_text))
    }
    return parts.joinToString(" · ")
}
