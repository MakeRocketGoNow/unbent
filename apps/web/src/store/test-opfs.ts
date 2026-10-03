import { vi } from 'vitest';

/**
 * An origin-private file system in memory, for tests of what is written to one
 * (`files.ts`, the keeper, an upload waiting in the outbox). jsdom has none. Only what
 * those call: directories and files by name, `entries` and `keys`, `removeEntry`, and a
 * writable that swaps its contents in on `close`, as the real one does — so a test can
 * see that an aborted write left nothing behind.
 */
class NotFound extends Error {
  override name = 'NotFoundError';
}

class MemoryFile {
  readonly kind = 'file' as const;
  data: Blob = new Blob([]);
  constructor(readonly name: string) {}
  async getFile(): Promise<File> {
    return new File([this.data], this.name);
  }
  async createWritable() {
    const parts: BlobPart[] = [];
    let open = true;
    const sink = {
      write: async (chunk: BlobPart) => {
        if (!open) throw new Error('closed');
        parts.push(chunk);
      },
      close: async () => {
        open = false;
        this.data = new Blob(parts);
      },
      abort: async () => {
        open = false;
      },
    };
    // `pipeTo` wants a real WritableStream; one that forwards to the sink is enough.
    const stream = new WritableStream<Uint8Array>({ write: (chunk) => sink.write(chunk as BlobPart) });
    return Object.assign(stream, sink, { close: sink.close, abort: sink.abort });
  }
}

export class MemoryDirectory {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MemoryDirectory | MemoryFile>();
  constructor(readonly name = '') {}

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<MemoryDirectory> {
    const found = this.children.get(name);
    if (found instanceof MemoryDirectory) return found;
    if (found || !opts.create) throw new NotFound(name);
    const made = new MemoryDirectory(name);
    this.children.set(name, made);
    return made;
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<MemoryFile> {
    const found = this.children.get(name);
    if (found instanceof MemoryFile) return found;
    if (found || !opts.create) throw new NotFound(name);
    const made = new MemoryFile(name);
    this.children.set(name, made);
    return made;
  }

  async removeEntry(name: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const found = this.children.get(name);
    if (!found) throw new NotFound(name);
    if (found instanceof MemoryDirectory && found.children.size > 0 && !opts.recursive) throw new Error('not empty');
    this.children.delete(name);
  }

  async *entries(): AsyncGenerator<[string, MemoryDirectory | MemoryFile]> {
    for (const entry of [...this.children]) yield entry;
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of [...this.children.keys()]) yield name;
  }

  /** Every file under this directory, by path: what a test asserts on. */
  paths(prefix = ''): string[] {
    return [...this.children].flatMap(([name, child]) => (child instanceof MemoryDirectory ? child.paths(`${prefix}${name}/`) : [`${prefix}${name}`])).sort();
  }
}

/** Installs the file system as `navigator.storage` and makes `filesSupported()` true; undo with `vi.unstubAllGlobals()`. */
export function installMemoryOpfs(): MemoryDirectory {
  const root = new MemoryDirectory();
  vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: true, storage: { getDirectory: async () => root, estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }), persist: vi.fn(async () => true), persisted: async () => true } });
  vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
  return root;
}
