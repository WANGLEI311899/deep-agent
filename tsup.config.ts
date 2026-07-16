import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/**/*.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // package.json 里的运行脚本使用 .mjs，固定输出扩展名避免构建产物与启动路径不一致。
  outExtension: () => ({ js: '.mjs' }),
})
