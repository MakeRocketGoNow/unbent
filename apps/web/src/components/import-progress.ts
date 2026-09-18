import type { ImportProgress } from '@unbent/enex';

/**
 * How full the progress bar is, as a percentage.
 *
 * Two ways to measure how far along an import is, one per format, because each format
 * knows a different thing before it starts.
 *
 * An archive lists every note directory up front, so it counts notes: the bar is notes
 * processed out of the total. That is the unit the person is watching — the count beside
 * the bar shows the same notes mounting up — and it is steady, because an import's time
 * is mostly a server round-trip per note. Bytes were the wrong unit here: a real export
 * is almost entirely its attachments, so a couple of notes with images are nearly the
 * whole file, and a byte bar raced to full on them and then crawled across the dozens of
 * text notes that were most of the actual work.
 *
 * An ENEX cannot count notes — the parser streams the file and only learns how many notes
 * there were once it reaches the end — so it measures bytes off that stream instead, which
 * for a single flat file is an honest proxy. That is the `notesTotal === 0` branch.
 *
 * Pinned to 100% when the run is over: an ENEX reads its last bytes just before the final
 * notes finish uploading, so a byte bar can otherwise stop a percent short and read as
 * stalled on a run that has in fact finished.
 */
export function importPercent(
  progress: ImportProgress | null,
  fileSize: number,
  done: boolean,
): number {
  if (done) return 100;
  if (!progress) return 0;
  if (progress.notesTotal > 0) {
    return Math.min(100, Math.round((progress.processed / progress.notesTotal) * 100));
  }
  if (fileSize > 0) {
    return Math.min(100, Math.round((progress.bytesRead / fileSize) * 100));
  }
  return 0;
}
