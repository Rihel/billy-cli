import { z } from 'zod'

/** 应用运行配置：前端启动时调用 /config/get 获取，据此控制 UI 展示 */
export const AppConfigSchema = z.object({
  /** 用户体系开关：false 时隐藏登录 / 用户管理相关 UI，后端守卫放行 */
  authEnabled: z.boolean(),
})
export type AppConfigModel = z.infer<typeof AppConfigSchema>
