import { importFormat, type ImportFormat } from '@unbent/enex';

/**
 * What the picker says about the file it was handed, before Start is pressed.
 *
 * The two importers do different things with a name — an ENEX file's name becomes the
 * notebook, an archive's is ignored because every note names its own — and that is the
 * one thing worth saying before the run, since it is the one thing the person can still
 * change by renaming the file. A file neither importer takes is named for what it is not,
 * and `format` is null so the button stays off.
 */
export interface ImportFileDescription {
  format: ImportFormat | null;
  text: string;
}

export function describeImportFile(name: string): ImportFileDescription {
  const format = importFormat(name);
  switch (format) {
    case 'enex':
      return {
        format,
        text: `Evernote export. Notes will be filed in a notebook called “${name.replace(/\.enex$/i, '')}”.`,
      };
    case 'zip':
      return {
        format,
        text: 'Unbent export. Each note keeps its own notebook, tags, dates, fields and files.',
      };
    case 'markdown':
      return { format, text: 'One Unbent note.' };
    default:
      return { format, text: 'Not a file this can import. Choose an .enex, .zip or .md file.' };
  }
}
