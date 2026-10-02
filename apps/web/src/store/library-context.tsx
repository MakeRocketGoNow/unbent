import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { acquireLibrary, type Library } from './library.js';

const LibraryContext = createContext<Library | null>(null);

/**
 * Opens the signed-in account's library and hands it to the tree. `null` until the local
 * store has opened — a few milliseconds on a warm device — and across a change of
 * account, when the previous library is closed before the next opens.
 */
export function LibraryProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [library, setLibrary] = useState<Library | null>(null);
  useEffect(() => {
    let alive = true;
    setLibrary(null);
    void acquireLibrary(userId).then((l) => {
      if (alive) setLibrary(l);
    });
    return () => {
      alive = false;
    };
  }, [userId]);
  return <LibraryContext.Provider value={library}>{children}</LibraryContext.Provider>;
}

/** The library, or null while it opens or outside the signed-in app. */
export function useLibrary(): Library | null {
  return useContext(LibraryContext);
}
