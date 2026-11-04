import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 开发模式：前端 5173，API 转发到本地服务 8790
// 生产模式：npm run build 产出 dist/，由 `yhub gui` 直接托管
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8790',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
