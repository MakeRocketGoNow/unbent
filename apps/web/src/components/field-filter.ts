import { isCurrencyField, parseFieldFilter, type FieldDef } from '@unbent/shared';
import { formatCurrency } from './format-field.js';

/** A range bound as the chip shows it: money for an amount, otherwise as typed. */
function bound(def: FieldDef | undefined, value: string | undefined): string {
  const n = Number(value);
  return def && isCurrencyField(def) && value !== undefined && value !== '' && Number.isFinite(n)
    ? formatCurrency(n, def.currency!)
    : (value ?? '');
}

/**
 * What a field filter says, in words, for its chip and for a screen reader.
 *
 * The definition supplies the name and the type; the filter supplies the op and the value.
 * A checkbox reads as a statement rather than "Reimbursed: true", because that is how a
 * person would say it. Dates and numbers keep the symbols ("Amount ≥ 20" is what the
 * control that set it showed, and an amount's bound is drawn as money, "Price ≥ $20")
 * and `set`/`empty` are the two words the picker used.
 *
 * A filter whose field is not among the definitions (a link from before the field was
 * deleted, or a filter on a field from another notebook) is still named, by what can be
 * read of it, so the chip that removes it is not blank.
 */
export function fieldFilterLabel(raw: string, defs: FieldDef[]): string {
  const f = parseFieldFilter(raw);
  if (!f) return 'Unreadable field filter';
  const def = defs.find((d) => d.id === f.fieldId);
  const name = def?.name ?? 'Unknown field';
  switch (f.op) {
    case 'set':
      return `${name} is set`;
    case 'empty':
      return `${name} is empty`;
    case 'gte':
      return `${name} ≥ ${bound(def, f.value)}`;
    case 'lte':
      return `${name} ≤ ${bound(def, f.value)}`;
    case 'eq':
      if (def?.type === 'checkbox') return f.value === 'true' ? name : `Not ${name.toLowerCase()}`;
      return `${name}: ${f.value}`;
  }
}
