import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The renderer is a plain Vite + React app, built to `dist-renderer` and loaded
 * from disk by Electron. `base: './'` matters: a packaged app loads over the
 * file: protocol, where absolute asset paths resolve to the filesystem root and
 * silently 404.
 */
export default defineConfig({
    root: 'src/renderer',
    base: './',
    build: { outDir: '../../dist-renderer', emptyOutDir: true },
    server: { port: 5273, strictPort: true },
    plugins: [react()],
});
