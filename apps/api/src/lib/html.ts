/**
 * A string made safe to put into HTML, as text or as a double-quoted attribute's value.
 * Single quotes are left alone: nothing here writes an attribute in them. One copy for the
 * Worker, so that the sign-in email and the prerendered pages cannot come to escape
 * differently.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
