package app.unbent.android

import app.unbent.android.ui.tagsWithDraft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * A tag typed but never confirmed with the keyboard's Done key must still reach the note
 * when the sheet's own button is tapped. The rule for taking it is the rule the Done key
 * uses, so the two ways of entering a tag cannot disagree.
 */
class TagEditorTest {

    @Test
    fun `a tag still in the field goes with the note`() {
        assertEquals(listOf("Receipts"), tagsWithDraft(emptyList(), "Receipts"))
        assertEquals(listOf("Dentist", "2026"), tagsWithDraft(listOf("Dentist"), "  2026 "))
    }

    @Test
    fun `an empty field changes nothing`() {
        val tags = listOf("Dentist")
        assertSame(tags, tagsWithDraft(tags, ""))
        assertSame(tags, tagsWithDraft(tags, "   "))
    }

    @Test
    fun `a tag the note already has is not added twice, whatever its case`() {
        val tags = listOf("Dentist")
        assertSame(tags, tagsWithDraft(tags, "dentist"))
    }
}
