import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./harness', import.meta.url)),
  publicDir: fileURLToPath(new URL('../fixtures/generated', import.meta.url)),
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
