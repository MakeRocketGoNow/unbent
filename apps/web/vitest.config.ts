import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The rich-markdown extension is tested against a real EditorView, which needs a DOM.
    environment: 'jsdom',
    // Fills in the Range measurement APIs jsdom omits, which CodeMirror calls whenever it
    // measures. Global rather than per-file: six test files construct an EditorView, and
    // which one the failure lands on is a matter of timing. See the file for the why.
    setupFiles: ['./src/test-setup.ts'],
  },
});
