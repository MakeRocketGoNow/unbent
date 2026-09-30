import { Workbox } from 'workbox-window';

/**
 * Installs the service worker that keeps the app openable without a connection — see
 * `sw/sw.ts` for what it holds.
 *
 * Only in a production build. Vite's development server serves source modules under
 * names that change with every edit, and a worker caching those would serve yesterday's
 * code; the worker is tried against the built app the Worker serves instead.
 *
 * Through `workbox-window` rather than `vite-plugin-pwa`'s virtual module, so that the
 * plugin's only job is writing the file list into the worker and it can be replaced
 * without touching this.
 *
 * Nothing waits on this. Registration fetches `/sw.js` and precaches the shell in the
 * background; a browser without service workers, or a registration that fails, leaves
 * the app exactly as it was before there was one.
 */
export function registerServiceWorker(): Workbox | undefined {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return undefined;
  const wb = new Workbox('/sw.js');
  wb.register().catch(() => {
    // An insecure origin, a private window that refuses storage, a WebView built without
    // it: the app still works, it just cannot open offline.
  });
  return wb;
}
