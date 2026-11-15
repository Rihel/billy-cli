import { Pages } from './constants'

/**
 * 管理台的**顶层分区**（由全局顶栏 `AppTopBar` 呈现）。
 *
 * - `chat`：会话工作台（AI 对话，`/main/ai/chat/**`）；
 * - `console`：管理台（控制台 / AI 配置 / 运维监控 / 系统设置，以及用户中心等其余页面）。
 *
 * 为什么这段判据单独放 `lib` 而不是写在组件里：顶栏是客户端组件，
 * 而"某个路径属于哪个分区"是**纯函数**（没有 DOM、没有 hooks），
 * 单独放这里才能被 node 环境的单测直接覆盖（`test/app-sections.test.ts`），
 * 前缀边界这类低级错误才不会只在手点时暴露。
 */
export type AppSectionKey = 'chat' | 'console'

/**
 * 是否落在会话分区。
 *
 * 必须带上分隔符再比前缀：只写 `startsWith('/main/ai/chat')` 会把
 * `/main/ai/chatxxx` 这种并不存在的兄弟路径也算成会话。
 */
export const isChatPath = (pathname: string): boolean =>
  pathname === Pages.chat || pathname.startsWith(`${Pages.chat}/`)

/** 路径 → 顶层分区（管理台是兜底：除会话外的一切管理面） */
export const sectionOf = (pathname: string): AppSectionKey =>
  isChatPath(pathname) ? 'chat' : 'console'
