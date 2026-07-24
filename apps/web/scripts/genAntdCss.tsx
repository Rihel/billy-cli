/**
 * Pre-generate all Ant Design CSS (including CSS variable definitions) as a
 * static file to avoid FOUC on first render.
 *
 * AntdRegistry only captures component CSS rules through @ant-design/cssinjs,
 * but antd v6's CSS variable definitions (:root { --app-color-primary: ... })
 * are injected via a separate mechanism and are NOT captured. This script uses
 * @ant-design/static-style-extract to render every antd component and capture
 * the complete CSS — variables included — at build time.
 *
 * Run: tsx scripts/genAntdCss.tsx
 * Output: src/styles/antd.min.css
 */
import { extractStyle } from '@ant-design/static-style-extract'
import { ConfigProvider } from 'antd'
import { createElement } from 'react'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const css = extractStyle((node) =>
  createElement(
    ConfigProvider,
    { theme: { cssVar: { key: 'app' }, hashed: false } },
    node,
  ),
)

const outDir = join(process.cwd(), 'src/styles')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'antd.min.css'), css)

console.log('✓ Generated src/styles/antd.min.css')
