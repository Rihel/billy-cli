'use client'

import type { CustomRenderer } from 'streamdown'

import { FENCE_LANGUAGES } from './fence-spec.ts'
import { GsapFence } from './gsap-fence.tsx'
import { HtmlFence } from './html-fence.tsx'
import { JsonFence } from './json-fence.tsx'
import { XflowFence } from './xflow-fence.tsx'

/**
 * 富内容围栏的注册表：`language → 组件`，直接交给 Streamdown 的 `plugins.renderers`。
 *
 * 加一种新围栏 = 写一个组件 + 在这里加一行 + 在提示词里说明写法，不改解析层。
 * 语言标识集中定义在 `FENCE_LANGUAGES`，避免"注册的名字"和"提示词里写的名字"各写一遍再对不上。
 */
export const markdownFenceRenderers: CustomRenderer[] = [
  { language: FENCE_LANGUAGES.xflow, component: XflowFence },
  { language: FENCE_LANGUAGES.html, component: HtmlFence },
  { language: FENCE_LANGUAGES.gsap, component: GsapFence },
  { language: FENCE_LANGUAGES.json, component: JsonFence },
]

/** 由前端渲染（而不是当普通代码块）的语言标识 */
export const RENDERED_FENCE_LANGUAGES: readonly string[] = markdownFenceRenderers.flatMap(
  (renderer) => (Array.isArray(renderer.language) ? renderer.language : [renderer.language]),
)
