import { defineConfig } from 'vite';

// GH-Pages base path. For project-page deploy (username.github.io/MemeLab/),
// set VITE_BASE=/MemeLab/ in the deploy workflow. Defaults to '/' for local + user-page.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    cssMinify: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          uplot: ['uplot'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
    open: false,
  },
  preview: {
    port: 4173,
  },
});
