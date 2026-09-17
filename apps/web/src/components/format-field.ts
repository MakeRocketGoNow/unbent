import { MAX_STAR_GLYPHS, ratingRendersAsStars, type FieldScale, type FieldType, type FieldValue } from '@unbent/shared';

/**
 * A rating as glyphs: filled, half and empty stars up to the scale's max.
 *
 * `½` rather than a half-star character, because no half star exists in a font that can
 * be relied on — the ones that look right are icon fonts or SVG. A digit-and-a-half is
 * unambiguous in a row of stars and reads at a list row's size, which the alternative of
 * rounding to the nearest whole star does not: a 3.5 shown as ★★★★ is simply wrong.
 */
function formatRating(value: number, scale: FieldScale): string {
  if (!ratingRendersAsStars(scale)) return `${value}/${scale.max}`;
  const stars = Math.min(scale.max, MAX_STAR_GLYPHS);
  let out = '';
  for (let star = 1; star <= stars; star += 1) {
    if (value >= star) out += '★';
    else if (value >= star - 0.5) out += '½';
    else out += '☆';
  }
  return out;
}

/**
 * A field value as a person reads it, in a list row or a collapsed summary.
 *
 * Only the kinds whose stored form is not already readable are touched: a checkbox says
 * Yes or No rather than true or false, a number gets the viewer's separators, and a
 * rating is drawn as its stars. Dates stay `YYYY-MM-DD` — it sorts by eye, and it is what
 * the person typed.
 */
export function formatFieldValue(
  type: FieldType,
  value: FieldValue,
  scale?: FieldScale | null,
): string {
  if (type === 'checkbox') return value === true || value === 'true' ? 'Yes' : 'No';
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    // A rating is a number, so this is the one branch that has to ask the definition
    // rather than the type; see `isRatingField`.
    return scale ? formatRating(n, scale) : n.toLocaleString();
  }
  return String(value);
}
