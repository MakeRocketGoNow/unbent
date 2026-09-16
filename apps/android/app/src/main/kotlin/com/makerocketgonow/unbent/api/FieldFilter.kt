package com.makerocketgonow.unbent.api

/**
 * One filter on a custom field, as it travels to the server: `<fieldId>:<op>[:<value>]`.
 *
 * Mirrors `parseFieldFilter` in `packages/shared/src/fields.ts`. The id and the op can hold
 * no `:`, so the first two are the separators and the value is everything after them —
 * a select option with a colon in it travels unescaped. Several go up as the `field` key
 * repeated, ANDed, the way `tag` does.
 *
 * Kept as the wire string in [NotesState] rather than as this class, for the reason the
 * web keeps it as a string in the URL: the server parses it itself, and one spelling per
 * filter is what makes two filters comparable. This class is how a chip or a control reads
 * one back.
 */
data class FieldFilter(val fieldId: String, val op: Op, val value: String? = null) {
    enum class Op(val wire: String) {
        /** Equals the stored text: a select's option, a checkbox's `true`/`false`. */
        EQ("eq"),
        /** At least, on a number or a date. */
        GTE("gte"),
        /** At most, on a number or a date. */
        LTE("lte"),
        /** Holds any value at all. */
        SET("set"),
        /** Holds no value. */
        EMPTY("empty"),
        ;

        val takesValue: Boolean get() = this == EQ || this == GTE || this == LTE
    }

    fun format(): String = if (value == null) "$fieldId:${op.wire}" else "$fieldId:${op.wire}:$value"

    companion object {
        private val ID = Regex("^[A-Za-z0-9-]{1,64}$")

        /** Reads a wire string, or null for anything the server would refuse. */
        fun parse(raw: String): FieldFilter? {
            val a = raw.indexOf(':')
            if (a < 0) return null
            val fieldId = raw.substring(0, a)
            if (!ID.matches(fieldId)) return null
            val rest = raw.substring(a + 1)
            val b = rest.indexOf(':')
            val opWire = if (b < 0) rest else rest.substring(0, b)
            val op = Op.entries.firstOrNull { it.wire == opWire } ?: return null
            if (!op.takesValue) return if (b < 0) FieldFilter(fieldId, op) else null
            if (b < 0) return null
            val value = rest.substring(b + 1)
            if (value.isEmpty() || value.length > MAX_VALUE) return null
            return FieldFilter(fieldId, op, value)
        }

        /** `MAX_FIELD_VALUE_LENGTH` in the shared package. */
        private const val MAX_VALUE = 1000
    }
}
