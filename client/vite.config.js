import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tailwind v4 is CSS-first — there is no tailwind.config.js.
// Design tokens live in src/index.css under @theme.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
    },
});
