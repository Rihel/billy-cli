import { z } from 'zod'

/** 日志组件配置：装配期读取（configureLogger），无 DI 消费者。 */
export const LoggerConfigSchema = z.object({
  name: z.string().default('app'),
  pretty: z.boolean().default(false),
})

export type LoggerConfig = z.infer<typeof LoggerConfigSchema>

/** DI 注入 token（可注册供应用层读取；组件本身不注入它） */
export const LoggerConfig = Symbol.for('LoggerConfig')
