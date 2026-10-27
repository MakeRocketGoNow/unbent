/**
 * A style on a plain number field, beside its scale and its currency: `year` so far.
 *
 * What a style is, and why it is a column on the definition rather than a type, is said
 * once on `FieldStyle` in `@unbent/shared`. NULL is a plain number, which is every row
 * written before this file, so nothing is backfilled and the feed has nothing to hear:
 * a definition's rendered shape is unchanged until someone gives it a style, and that
 * write records the notebook as any field edit does.
 */
export default `
ALTER TABLE notebook_fields ADD COLUMN style TEXT;
`;
