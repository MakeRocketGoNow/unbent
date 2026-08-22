import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The rich-markdown extension is tested against a real EditorView, which needs a DOM.
    environment: 'jsdom',
  },
});
