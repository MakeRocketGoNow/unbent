import {
  MAX_STAR_GLYPHS,
  ratingRendersAsStars,
  type FieldScale,
  type FieldStyle,
  type FieldType,
  type FieldValue,
} from '@unbent/shared';

/**
 * A rating as glyphs: filled, half and empty stars up to the scale's max.
 *
 * `½` rather than a half-star character, because no half star exists in a font that can
 * be relied on: the ones that look right are icon fonts or SVG. A digit-and-a-half is
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
 * Yes or No rather than true or false, a number gets the viewer's separators, a rating is
 * drawn as its stars, an amount as money, and a multi-select's options are joined with
 * commas. Dates stay `YYYY-MM-DD`: it sorts by eye, and it is what the person typed. A
 * year is left as it was typed too: `2,026` is how a quantity reads, and a year is not one.
 */
export function formatFieldValue(
  type: FieldType,
  value: FieldValue,
  scale?: FieldScale | null,
  currency?: string | null,
  style?: FieldStyle | null,
): string {
  if (Array.isArray(value)) return value.join(', ');
  if (type === 'checkbox') return value === true || value === 'true' ? 'Yes' : 'No';
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return String(value);
    // A rating and an amount are both numbers, so this is the one branch that has to ask
    // the definition rather than the type; see `isRatingField` and `isCurrencyField`.
    if (scale) return formatRating(n, scale);
    if (currency) return formatCurrency(n, currency);
    if (style === 'year') return String(n);
    return n.toLocaleString();
  }
  return String(value);
}

/**
 * A number as money in the viewer's locale: `$1,234.50`, `€1.234,50`, `¥1,235`.
 *
 * `Intl` knows every ISO 4217 code and draws one it has no symbol for as the code beside
 * the number, so the fallback is only for a code that is not even the right shape, which
 * the schema already refuses at the API.
 */
export function formatCurrency(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toLocaleString()} ${currency}`;
  }
}

/**
 * An amount as it sits in its input: `141.80` for a stored `141.8`, as a price is
 * written, and the digits the person typed beyond that left alone.
 *
 * Padded to the currency's own minor unit (two places for dollars, none for yen) and
 * never rounded: a stored `12.345` reads `12.345`, because an input that showed less
 * than the value would save less the next time it was touched. Without the symbol or the
 * separators of `formatCurrency`, since this is the text being edited, and a `1,234.50`
 * typed back would not parse. A string that is not a plain decimal (one still being
 * typed, `12.`) is returned as it is.
 */
export function amountText(value: FieldValue, currency: string): string {
  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  const decimals = text.split('.')[1]?.length ?? 0;
  const digits = currencyDigits(currency);
  return decimals >= digits ? text : Number(text).toFixed(digits);
}

/** How many places a currency's amounts are written to: 2 for USD, 0 for JPY. */
function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions()
      .minimumFractionDigits ?? 0;
  } catch {
    return 0;
  }
}

/** The symbol a currency draws with (`$`, `€`, `£`) or the code where it has none. */
export function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}
