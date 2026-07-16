import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const apiTarget = process.env.BVA_API_TARGET ?? 'http://127.0.0.1:3000'

export default defineConfig({
  base: './',
  plugins: [vue()],
  cacheDir: '.vite-cache',
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
