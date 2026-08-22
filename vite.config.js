import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * manifest.json is emitted into dist/ by this plugin rather than being copied
 * from publicDir, so that later changes can substitute build-time values into
 * it — something publicDir's verbatim copy could never do.
 */
function manifestPlugin() {
    return {
        name: 'manifest',
        generateBundle() {
            const source = readFileSync(resolve(import.meta.dirname, 'manifest.json'), 'utf8');
            JSON.parse(source); // fail the build rather than ship a broken manifest
            this.emitFile({ type: 'asset', fileName: 'manifest.json', source });
        }
    };
}

export default defineConfig(({ mode }) => ({
    root: 'src',
    publicDir: resolve(import.meta.dirname, 'public'),
    plugins: [manifestPlugin()],
    build: {
        outDir: resolve(import.meta.dirname, 'dist'),
        emptyOutDir: true,
        target: 'esnext',                 // MV3 is modern Chrome only
        minify: mode !== 'development',
        sourcemap: mode === 'development',
        rollupOptions: {
            input: {
                popup: resolve(import.meta.dirname, 'src/popup/popup.html')
            },
            output: {
                format: 'es',
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name][extname]'
            }
        }
    }
}));
