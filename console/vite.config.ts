import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `bun run dev:phone` serves over HTTPS on the local network: WebXR depth sensing
// and the microphone only work in a secure context. The bridge is proxied under
// /bridge so a page served over HTTPS can reach it as wss:// on the same origin.
const phone = process.env.FATHOM_HTTPS === '1'

export default defineConfig({
  // GitHub Pages serves the console under /<repository>/
  base: process.env.FATHOM_BASE ?? '/',
  plugins: [react(), ...(phone ? [basicSsl()] : [])],
  server: {
    host: phone ? true : undefined,
    proxy: { '/bridge': { target: 'ws://127.0.0.1:8765', ws: true, rewrite: () => '/' } },
  },
  worker: { format: 'es' },
  // Cache the renderer independently when the console or identity changes.
  // Vite emits a modulepreload link so this does not add a discovery waterfall.
  build: {
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'three', test: /node_modules\/three\// }] } },
    },
  },
})
