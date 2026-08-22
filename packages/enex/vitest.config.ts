import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // pdf.js expects browser/worker globals that Node lacks; see the setup file.
    setupFiles: ['./test/pdf-globals-setup.ts'],
  },
});
