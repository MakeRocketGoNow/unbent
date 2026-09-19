/**
 * A reader for the CSV Notion writes beside each database: RFC 4180, with a UTF-8 byte
 * order mark, CRLF or LF line ends, and quoted fields that double their quotes and may
 * run across lines — a long-text property is one cell however many paragraphs it holds.
 *
 * Hand-written rather than a dependency because this is the whole of what the format
 * needs, and the one behaviour that matters — a newline inside quotes is not a row break —
 * is exactly what a split-on-newline reader gets wrong.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // A blank line is not a row; Notion never writes one, but a hand-edited file might.
  return rows.filter((r) => r.some((cell) => cell !== ''));
}
