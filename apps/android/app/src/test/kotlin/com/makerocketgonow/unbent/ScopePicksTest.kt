package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.Notebook
import com.makerocketgonow.unbent.api.Tag
import com.makerocketgonow.unbent.ui.ScopePick
import com.makerocketgonow.unbent.ui.scopePicks
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the search offers as picks above its results.
 *
 * Pinned: a name containing the term is offered and one that does not is not; what is
 * already applied is left out; the offer is capped; tags come before notebooks.
 */
class ScopePicksTest {
    private val tags = listOf(
        Tag("Receipt", 9), Tag("Recipe", 4), Tag("Rec Center", 3), Tag("Wreck", 2),
        Tag("Record", 2), Tag("Recall", 1), Tag("Recliner", 1), Tag("Ash", 1),
    )
    private val notebooks = listOf(Notebook("1", "Recipes", 5), Notebook("2", "Coupons", 3))

    private fun names(q: String, selected: List<String> = emptyList(), notebook: String? = null) =
        scopePicks(q, tags, notebooks, selected, notebook).map {
            (if (it is ScopePick.ForTag) "tag:" else "notebook:") + it.name
        }

    @Test
    fun `offers what contains the term, anywhere in the name, tags first`() {
        assertEquals(listOf("tag:Ash"), names("ash"))
        assertEquals(listOf("tag:Wreck"), names("reck"))
        assertEquals(listOf("tag:Recipe", "notebook:Recipes"), names("recip"))
    }

    @Test
    fun `caps the offer so it stays above the notes`() {
        val offered = names("rec")
        assertEquals(5, offered.count { it.startsWith("tag:") })
        assertEquals(listOf("tag:Receipt", "tag:Recipe"), offered.take(2))
        assertEquals("notebook:Recipes", offered.last())
    }

    @Test
    fun `leaves out what is already applied`() {
        assertEquals(emptyList<String>(), names("recip", listOf("Recipe"), "Recipes"))
        assertEquals(listOf("notebook:Recipes"), names("recip", listOf("Recipe")))
    }

    @Test
    fun `offers nothing for a blank term or with nothing matching`() {
        assertEquals(emptyList<String>(), names("  "))
        assertEquals(emptyList<String>(), names("zzz"))
    }
}
