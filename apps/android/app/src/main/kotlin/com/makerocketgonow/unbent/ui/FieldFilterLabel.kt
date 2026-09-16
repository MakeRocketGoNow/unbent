package com.makerocketgonow.unbent.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.makerocketgonow.unbent.R
import com.makerocketgonow.unbent.api.FieldDef
import com.makerocketgonow.unbent.api.FieldFilter
import com.makerocketgonow.unbent.api.FieldFilter.Op

/**
 * What a field filter says, in words, for its chip, the title line and a screen reader.
 *
 * The definition supplies the name and the type; the filter supplies the op and the value.
 * A checkbox reads as a statement rather than "Reimbursed: true", because that is how a
 * person would say it. Dates are shown the way the rest of the app shows a day; numbers
 * keep the symbols the control that set them showed. The same words the web's chips use.
 *
 * A filter whose field is not among the definitions — a saved filter from before the
 * field was deleted — is still named, by what can be read of it, so the chip that removes
 * it is not blank.
 */
@Composable
fun fieldFilterLabel(raw: String, defs: List<FieldDef>): String {
    val f = FieldFilter.parse(raw) ?: return stringResource(R.string.field_filter_unreadable)
    val def = defs.firstOrNull { it.id == f.fieldId }
    val name = def?.name ?: stringResource(R.string.field_unknown)
    val value = f.value?.let { if (def?.type == "date") runCatching { formatDay(it) }.getOrDefault(it) else it }
    return when (f.op) {
        Op.SET -> stringResource(R.string.field_filter_set, name)
        Op.EMPTY -> stringResource(R.string.field_filter_empty, name)
        Op.GTE -> stringResource(R.string.field_filter_gte, name, value.orEmpty())
        Op.LTE -> stringResource(R.string.field_filter_lte, name, value.orEmpty())
        Op.EQ -> when {
            def?.type == "checkbox" && f.value == "true" -> name
            def?.type == "checkbox" -> stringResource(R.string.field_filter_not, name.lowercase())
            else -> stringResource(R.string.field_filter_eq, name, value.orEmpty())
        }
    }
}
