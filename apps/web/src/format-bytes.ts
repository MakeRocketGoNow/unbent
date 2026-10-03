/**
 * A size as a person reads one: `812 KB`, `1.2 GB`.
 *
 * Binary units (1 MB is 1,048,576 bytes), because every limit this sits beside is counted
 * that way: the upload cap the server states as "95MB", the 500 MB budget for opened
 * files, the sizes the attachments panel has always shown. A phone's own storage screen
 * counts in thousands, so a figure here reads about 7% lower than the phone's at the
 * gigabyte scale. Agreeing with the app's own limits was chosen over agreeing with that
 * screen: a file shown as 96 MB and refused at "95MB" has to be the same megabytes.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
