import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backendProxyUrl = process.env.BACKEND_PROXY_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: backendProxyUrl,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
