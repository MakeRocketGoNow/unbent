/**
 * Vite's `?url` import suffix, which resolves an asset to its served URL. TypeScript has
 * no knowledge of it, so the module shape is declared here.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
