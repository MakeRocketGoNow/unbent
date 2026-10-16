import { z } from 'zod';

/**
 * A calendar day, `YYYY-MM-DD`, as typed by a date input.
 *
 * Dates rather than timestamps because the filter is a human question ("everything from
 * 2023") and a timestamp boundary would make the answer depend on the hour. Interpreted
 * in UTC to match the epoch-ms columns; a local-midnight reading would shift the boundary
 * by the viewer's offset and quietly include or drop a day's notes.
 *
 * In its own module because both the note schemas and the custom-field codec need it, and
 * the field codec is imported by the schemas: a shared leaf keeps that a tree.
 */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'not a real date');

/** Start of that UTC day. */
export function startOfDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * End of that UTC day, inclusive.
 *
 * The range is inclusive of both ends because that is what a person means by "1 January
 * to 31 January": an exclusive upper bound silently drops everything filed on the last
 * day of the range.
 */
export function endOfDay(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}
