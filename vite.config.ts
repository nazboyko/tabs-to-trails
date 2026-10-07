import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const web = (file: string) => fileURLToPath(new URL(`./src/web/${file}`, import.meta.url));
const api = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: web(''),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: { index: web('index.html'), phone: web('phone.html') } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/w': api },
  },
});
