/**
 * Type-only shim for Vite's `?url` imports.
 *
 * @unbent/enex is consumed by the web app through Vite, where `vite/client` declares these.
 * This package compiles the same source without a bundler, so `pdf-text.ts`'s worker import
 * has no declaration and tsc fails on it.
 *
 * Declaring it here rather than depending on Vite: the CLI has no bundler and wants none,
 * and the import is already handled at runtime — pdf-text.ts catches the failed resolve and
 * falls back, because Node has no bundler to satisfy `?url` in the first place.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
