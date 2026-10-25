"use client"

import { JsonView } from "#components/json-view.tsx"
import type { CustomRendererProps } from "streamdown"

import { FencePending } from "./fence-chrome.tsx"

/**
 * ```` ```json ```` 围栏：渲染成可折叠的树，而不是一大块高亮代码。
 *
 * 为什么值得单独一种：会话里模型给配置、接口返回、事件 payload 时，读者要的是
 * "结构长什么样、哪个字段有值"，不是数括号。树形视图一层一行，长嵌套点开看，
 * 顶层给条数与类型摘要；原始 JSON 用「原文」切回去（含复制）。
 *
 * 未闭合时不渲染：半截 JSON 必然解析失败，弹一个红框比"等一下"更扰人。
 */
export const JsonFence = ({ code, isIncomplete, language }: CustomRendererProps) => {
  if (isIncomplete) {
    return <FencePending language={language} />
  }

  return (
    <div className="my-4" data-fence="json">
      {/* 「原文」与复制都在 JsonView 自己的工具栏里，这里不再套第二层折叠 */}
      <JsonView text={code} />
    </div>
  )
}
