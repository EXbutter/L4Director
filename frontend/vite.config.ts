import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// 打包/构建时把 package.json 的版本号注入前端（标题栏、侧边栏底部显示）
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    // 显式声明核心依赖，避免冷启动时的二次预构建与页面 reload
    include: ['react', 'react-dom', 'zustand', 'lucide-react'],
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8288',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
})
