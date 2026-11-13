import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages serves the console under /<repository>/
  base: process.env.FATHOM_BASE ?? '/',
  plugins: [react()],
  worker: { format: 'es' },
  // three.js alone is about 700 kB minified; one chunk loads faster than a waterfall here.
  build: { chunkSizeWarningLimit: 900 },
})
