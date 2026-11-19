import path from 'path'
import { defineConfig } from 'vitest/config'

/**
 * 前端单元测试配置。
 *
 * 单独一份而不是塞进 vite.config.ts：那边是 Electron 渲染层的构建配置
 * （root=frontend、产物目录、代理），测试不需要也不该继承这些。
 *
 * 只测**纯逻辑**（utils）：组件测试要拖 jsdom + testing-library，
 * 收益不如直接把渲染开销用性能预算守住（见 docs-internal/09）。
 */
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  // 默认缓存目录在系统临时目录下；某些受限环境（沙箱 / 组策略）不可写，
  // 会以「Unhandled Error: EPERM ... ssr\...」的形式让整轮测试判失败。
  cacheDir: path.resolve(__dirname, 'node_modules/.vitest-cache'),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
})
