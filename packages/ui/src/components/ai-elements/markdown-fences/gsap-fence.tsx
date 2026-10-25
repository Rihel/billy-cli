"use client"

import type { CustomRendererProps } from "streamdown"

import { FencePending, FenceSource } from "./fence-chrome.tsx"
import { SandboxFrame } from "./sandbox-frame.tsx"

/**
 * 内置动画库的静态路径。
 *
 * 由 `apps/admin/scripts/sync-vendor.mjs` 从 `node_modules/gsap/dist/gsap.min.js` 复制到
 * `apps/admin/public/vendor/`，随仓库提交 —— 沙箱 iframe 自己连不出去，
 * 所以脚本只能是"父页面同源取回、内联进文档"这一条路。
 */
const GSAP_SCRIPT = "/vendor/gsap.min.js"

/**
 * ```` ```gsap ```` 围栏：沙箱 iframe + 内置 gsap。
 *
 * 模型写一段 HTML（含它自己的 `<style>` / `<script>`），脚本里可以直接用 `gsap`：
 * 内置脚本在模型内容**之前**注入（`<head>` 里），所以模型代码执行时库已经就位 —— 这是
 * 实测踩到的坑：库放在内容之后时，模型的内联脚本先执行，直接 `gsap is not defined`。
 * DOM 的时序则遵循 HTML 本身：脚本写在要操作的元素之后，或等 `DOMContentLoaded`。
 */
export const GsapFence = ({ code, isIncomplete, language }: CustomRendererProps) => {
  if (isIncomplete) {
    return <FencePending language={language} />
  }
  return (
    <div className="my-4" data-fence="gsap">
      <SandboxFrame html={code} language="gsap" scripts={[GSAP_SCRIPT]} title="GSAP 动画" />
      <FenceSource code={code} />
    </div>
  )
}
