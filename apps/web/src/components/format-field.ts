import type { FieldType, FieldValue } from '@unbent/shared';

/**
 * A field value as a person reads it, in a list row or a collapsed summary.
 *
 * Only the two kinds whose stored form is not already readable are touched: a checkbox
 * says Yes or No rather than true or false, and a number gets the viewer's separators.
 * Dates stay `YYYY-MM-DD` — it sorts by eye, and it is what the person typed.
 */
export function formatFieldValue(type: FieldType, value: FieldValue): string {
  if (type === 'checkbox') return value === true || value === 'true' ? 'Yes' : 'No';
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : String(value);
  }
  return String(value);
}
