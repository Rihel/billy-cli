import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  // express 只用来取中间件签名（type-only）：声明文件是 CJS，不能被 dts 打包，
  // 必须当外部依赖留着，否则 rolldown-plugin-dts 会因为 @types/express 报 MISSING_EXPORT
  deps: { neverBundle: ['express'] },
  dts: true,
})
