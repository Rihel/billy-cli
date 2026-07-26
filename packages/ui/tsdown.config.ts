import { defineConfig } from 'tsdown'
import pkgJson from './package.json'
export default defineConfig({
  entry: ['./src/index.ts', './src/action.ts'],
  dts: true,
  deps: {
    neverBundle: Object.keys(pkgJson.dependencies),
  },
})
