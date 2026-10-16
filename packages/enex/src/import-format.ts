/** The kinds of file an import can read. */
export type ImportFormat = 'enex' | 'zip' | 'markdown';

/**
 * Which importer a file is for, from its name.
 *
 * By extension rather than by sniffing: the name is known before a byte is read, which is
 * what lets the picker say what it is about to do, and every producer of these files
 * (Evernote, this app's export, a text editor) names them conventionally. A file that
 * matches none is not guessed at; the caller says what it accepts.
 */
export function importFormat(name: string): ImportFormat | null {
  const match = /\.([^./\\]+)$/.exec(name);
  switch (match?.[1]?.toLowerCase()) {
    case 'enex':
      return 'enex';
    case 'zip':
      return 'zip';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return null;
  }
}
