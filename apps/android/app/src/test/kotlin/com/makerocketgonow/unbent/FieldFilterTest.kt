package com.makerocketgonow.unbent

import com.makerocketgonow.unbent.api.FieldFilter
import com.makerocketgonow.unbent.api.FieldFilter.Op
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The field filter's wire form, read back and written out.
 *
 * The id and the op can hold no `:`, so the first two are the separators and the value is
 * whatever follows — which is what lets a select option with a colon in it travel
 * unescaped. Everything unreadable is null, the same set the server refuses.
 */
class FieldFilterTest {
    private val id = "6f4c1b2e-9c1d-4a6e-8b7f-0123456789ab"

    @Test
    fun `round-trips each op`() {
        for (f in listOf(
            FieldFilter(id, Op.EQ, "Food"),
            FieldFilter(id, Op.GTE, "20"),
            FieldFilter(id, Op.LTE, "2026-01-10"),
            FieldFilter(id, Op.SET),
            FieldFilter(id, Op.EMPTY),
        )) {
            assertEquals(f, FieldFilter.parse(f.format()))
        }
    }

    @Test
    fun `keeps every character of the value, colons included`() {
        assertEquals(FieldFilter(id, Op.EQ, "Time: 10:30"), FieldFilter.parse("$id:eq:Time: 10:30"))
    }

    @Test
    fun `refuses what the server would`() {
        for (bad in listOf(
            "nonsense", id, "$id:between:1:2", "$id:eq", "$id:eq:", "$id:set:extra",
            "not an id:eq:Food", "$id:eq:" + "x".repeat(1001),
        )) {
            assertNull(bad, FieldFilter.parse(bad))
        }
    }
}
