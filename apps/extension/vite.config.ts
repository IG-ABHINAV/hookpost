import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// Used through scripts/build.mjs, which adds the manifest and makes the zip.
const { version } = JSON.parse(
  readFileSync(resolve(here, 'package.json'), 'utf8')
);

export default defineConfig(({ mode }) => {
  const dev = mode === 'development';
  return {
    // Constants background.ts reads. In the store build the dev branch is
    // dead code and dropped, so no localhost URL ships.
    define: {
      __HOOKPOST_DEV__: JSON.stringify(dev),
      __HOOKPOST_DEV_BACKEND_URL__: JSON.stringify(
        dev ? process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000' : ''
      ),
      __HOOKPOST_DEV_APP_URL__: JSON.stringify(
        dev ? process.env.FRONTEND_URL || 'http://localhost:4200' : ''
      ),
      __HOOKPOST_VERSION__: JSON.stringify(version),
    },
    build: {
      outDir: resolve(here, dev ? 'dist-dev' : 'dist'),
      emptyOutDir: true,
      // Two entries that share no module (popup.view.ts imports nothing),
      // so no shared chunk: build.mjs fails on any file it does not expect.
      lib: {
        entry: {
          background: resolve(here, 'src/background.ts'),
          popup: resolve(here, 'src/popup.ts'),
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
        },
      },
      target: 'esnext',
      // Readable for the Chrome Web Store review: no minification.
      minify: false,
      sourcemap: dev,
    },
    publicDir: resolve(here, 'public'),
  };
});
