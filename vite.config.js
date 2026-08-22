import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * manifest.template.json can't read import.meta.env, so placeholders in it are
 * substituted at build time from the environment. Phase 1 introduces
 * __OAUTH_CLIENT_ID__ and __EXT_PUBLIC_KEY__; unknown placeholders are
 * left alone so an unconfigured checkout still builds.
 *
 * The template is deliberately NOT named manifest.json: a manifest containing
 * unsubstituted placeholders is rejected by Chrome, and having one at the repo
 * root invites loading the wrong folder. Only dist/ is ever loadable.
 */
function manifestPlaceholders(env) {
    return {
        name: 'manifest-placeholders',
        generateBundle() {
            const src = resolve(import.meta.dirname, 'manifest.template.json');
            let json = readFileSync(src, 'utf8');
            for (const [key, value] of Object.entries(env)) {
                json = json.replaceAll(`__${key}__`, value);
            }

            const manifest = JSON.parse(json); // fails the build on a bad substitution

            // Chrome rejects the whole extension if `key` isn't valid base64 or
            // `oauth2.client_id` is blank. Without config, drop those fields
            // instead of shipping placeholders: sign-in won't work, but
            // everything else still loads.
            if (!env.EXT_PUBLIC_KEY) delete manifest.key;
            if (!env.OAUTH_CLIENT_ID) delete manifest.oauth2;

            if (!env.EXT_PUBLIC_KEY || !env.OAUTH_CLIENT_ID) {
                this.warn(
                    'Building without EXT_PUBLIC_KEY / OAUTH_CLIENT_ID — Google ' +
                    'sign-in is disabled in this build. See .env.example.'
                );
            }

            this.emitFile({
                type: 'asset',
                fileName: 'manifest.json',
                source: JSON.stringify(manifest, null, 2) + '\n'
            });
        }
    };
}

export default defineConfig(({ mode }) => {
    // envDir must be pinned to the repo root: it defaults to `root`, which is
    // 'src' here, so .env.local at the project root would otherwise be ignored
    // entirely — silently producing a build with no Firebase config.
    const envDir = import.meta.dirname;

    // Third argument '' loads every key, not just the VITE_-prefixed ones.
    // These two are consumed by the manifest plugin rather than by client code,
    // so they intentionally carry no VITE_ prefix and are never inlined into
    // the bundle. Vite does not populate process.env from .env files.
    const loaded = loadEnv(mode, envDir, '');
    const env = {
        OAUTH_CLIENT_ID: loaded.OAUTH_CLIENT_ID ?? '',
        EXT_PUBLIC_KEY: loaded.EXT_PUBLIC_KEY ?? ''
    };

    return {
        root: 'src',
        envDir,
        publicDir: resolve(import.meta.dirname, 'public'),
        plugins: [manifestPlaceholders(env)],
        build: {
            outDir: resolve(import.meta.dirname, 'dist'),
            emptyOutDir: true,
            target: 'esnext',
            minify: mode !== 'development',
            sourcemap: mode === 'development',
            rollupOptions: {
                input: {
                    popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
                    options: resolve(import.meta.dirname, 'src/options/options.html'),
                    'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.js')
                },
                output: {
                    format: 'es',
                    // The service worker's graph must stay static: dynamic
                    // import() is unreliable in MV3 module workers, so shared
                    // chunks are inlined into each entry rather than split out.
                    inlineDynamicImports: false,
                    entryFileNames: '[name].js',
                    chunkFileNames: 'chunks/[name]-[hash].js',
                    assetFileNames: 'assets/[name][extname]'
                }
            }
        }
    };
});
