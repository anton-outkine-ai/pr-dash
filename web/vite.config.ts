import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765' }, // dev: proxy API to FastAPI
  },
})
