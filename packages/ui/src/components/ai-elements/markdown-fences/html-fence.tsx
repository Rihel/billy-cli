'use client'

import type { CustomRendererProps } from 'streamdown'

import { FencePending, FenceSource } from './fence-chrome.tsx'
import { SandboxFrame } from './sandbox-frame.tsx'

/**
 * ```` ```html ```` 围栏：把模型写的页面直接跑在沙箱 iframe 里。
 *
 * 与 `gsap` 围栏同一套沙箱，差别只是不额外内联动画库 —— 这里写的 `<script>`、
 * 样式、布局都会真的生效，但拿不到后台页面的权限（见 `sandbox-frame` 注释）。
 */
export const HtmlFence = ({ code, isIncomplete, language }: CustomRendererProps) => {
  if (isIncomplete) {
    return <FencePending language={language} />
  }
  return (
    <div className="my-4" data-fence="html">
      <SandboxFrame html={code} language="html" title="HTML 预览" />
      <FenceSource code={code} />
    </div>
  )
}
