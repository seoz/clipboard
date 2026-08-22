import { defineConfig } from 'vitest/config';

// Separate from vite.config.js: the extension build uses `root: 'src'`,
// but the tests live outside it.
export default defineConfig({
    test: {
        root: import.meta.dirname,
        include: ['test/**/*.test.js'],
        environment: 'node'
    }
});
