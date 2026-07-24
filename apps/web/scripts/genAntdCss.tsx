/**
 * Pre-generate all Ant Design CSS (including CSS variable definitions) as a
 * static file for reference or for use with external CSS preloading.
 *
 * NOTE: With antd v6 + Next.js App Router, the recommended approach to avoid
 * FOUC is to rely on `@ant-design/nextjs-registry`'s AntdRegistry for SSR
 * style injection. The AntdRegistry collects ALL CSS-in-JS styles during SSR
 * (including component styles and --ant-* CSS variable definitions from
 * cssVar) and injects them as inline <style> tags in the server-rendered
 * HTML — no separate CSS file needed.
 *
 * This script is kept as a reference utility. If you want to use this file
 * for CSS preloading (e.g., <link rel="preload">), run manually:
 *   $ pnpm gen:antd-css
 * and reference the output from an external <link> tag.
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
