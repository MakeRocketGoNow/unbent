import type { ImportProgress } from '@unbent/enex';

/**
 * How full the progress bar is, as a percentage.
 *
 * The numerator is bytes rather than notes so that one note carrying a 90MB video still
 * moves the bar. What that has to be divided by is the part worth writing down.
 *
 * An ENEX is read straight off its own stream, so the file's size is the total. A zip is
 * not: every entry costs a local header, a data descriptor and a central-directory record,
 * each carrying the full path, and none of that is ever read as note content. In this
 * app's own export those paths are long — a note's directory and its markdown are both
 * named for the note — and the markdown inside deflates to about a fifth of its size, so
 * for a library of text notes well over half the file is structure. Dividing by the file's
 * size left a complete import of 73 such notes under 40%, reading as a run that had
 * stalled with most of the file still to go. The archive importer knows the real figure
 * from the central directory and reports it as `bytesTotal`; this divides by that when it
 * has one.
 *
 * Capped, because the archive importer counts a file shared by two notes in one directory
 * once per note — a shape only a hand-repacked archive has, and not worth a slower reader.
 *
 * Pinned to 100% when the run is over: the last bytes are read before the final notes
 * finish uploading, so the bar can otherwise stop a percent short on a complete import.
 */
export function importPercent(
  progress: ImportProgress | null,
  fileSize: number,
  done: boolean,
): number {
  if (done) return 100;
  if (!progress) return 0;
  const total = progress.bytesTotal || fileSize;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((progress.bytesRead / total) * 100));
}
