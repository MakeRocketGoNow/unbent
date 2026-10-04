import type { LocalCoverage } from '../store/search-local.js';

/**
 * The line under a search answered on this device: that it was, and what it could not
 * see.
 *
 * A search with no connection reads the device's own index, which holds every note but
 * only some files' text — the notebooks kept offline, and notes opened here lately
 * (`store/search-local.ts`). So "No matches" offline can mean "not in a file this
 * device searched", and without this line it would read as "not in your notes". The
 * number is of files in the scope searched: inside a notebook that is kept offline there
 * is nothing unsearched, and the line says only where the answer came from.
 *
 * Under the list rather than in it. As a last row it would sit below fifty matches,
 * where the person it matters to — the one deciding whether to trust the list — never
 * scrolls; and a table has no last row to put it in. Below both, it is one element for
 * either view, where the indexing status already puts what the list cannot say itself.
 */
export function SearchCoverage({ coverage }: { coverage: LocalCoverage }) {
  return <p className="sidebar-status search-coverage">{coverageText(coverage)}</p>;
}

export function coverageText({ built, files }: LocalCoverage): string {
  if (!built) return 'Searched on this device, which is still indexing your notes. Some may be missing.';
  const missed = files.total - files.searched;
  if (missed <= 0) return 'Searched on this device.';
  const what = missed === 1 ? '1 file' : `${missed.toLocaleString()} files`;
  return `Searched on this device. The text of ${what} elsewhere was not searched: keep a notebook offline to search its files.`;
}
