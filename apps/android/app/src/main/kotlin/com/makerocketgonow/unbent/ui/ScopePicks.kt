package com.makerocketgonow.unbent.ui

import com.makerocketgonow.unbent.api.Notebook
import com.makerocketgonow.unbent.api.Tag

/** A tag or a notebook the search offers as a pick above its results. */
sealed class ScopePick {
    abstract val name: String
    abstract val count: Int

    data class ForTag(override val name: String, override val count: Int) : ScopePick()
    data class ForNotebook(override val name: String, override val count: Int) : ScopePick()
}

/** How many of each are offered. Enough to disambiguate, few enough to stay above the notes. */
private const val MAX_TAGS = 5
private const val MAX_NOTEBOOKS = 3

/**
 * Tags and notebooks whose names contain the search term, for the top of the results.
 *
 * Typing the name of a tag into the search box finds notes carrying it (the server indexes
 * tag names now), but the tag itself is usually what was being looked for — Evernote
 * offers it as a pick above the hits, and so does the web app since its filtering work.
 * Picking one applies the filter and closes the search, which is what it means to have
 * found the thing.
 *
 * Computed here rather than asked of the server: every tag and every notebook is already
 * in hand for the picker and the drawer, and a substring match over a few hundred names
 * is nothing. Substring rather than prefix for the reason the tag picker's find field is:
 * people remember a word from the middle of a name as readily as its first letter.
 *
 * Selected tags and the current notebook are left out — offering a filter that is already
 * on would be a pick that does nothing. Tags keep the API's order, by count, so the
 * likeliest pick is first. Notebooks come after tags: a tag is added to the scope and a
 * notebook replaces it, and the smaller step is offered first.
 */
fun scopePicks(
    query: String,
    tags: List<Tag>,
    notebooks: List<Notebook>,
    selectedTags: List<String>,
    notebook: String?,
): List<ScopePick> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    val tagPicks = tags
        .filter { it.name !in selectedTags && it.name.contains(needle, ignoreCase = true) }
        .take(MAX_TAGS)
        .map { ScopePick.ForTag(it.name, it.count) }
    val notebookPicks = notebooks
        .filter { it.name != notebook && it.name.contains(needle, ignoreCase = true) }
        .take(MAX_NOTEBOOKS)
        .map { ScopePick.ForNotebook(it.name, it.count) }
    return tagPicks + notebookPicks
}
