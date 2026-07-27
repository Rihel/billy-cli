import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { als } from './request-context.store.js'

/**
 * 从请求上下文中读取指定字段。
 *
 * @example
 * \`\`\`ts
 * @RequestContext('userId') userId: string
 * \`\`\`
 */
export const RequestContext = createParamDecorator(
  (key: string, _ctx: ExecutionContext) => {
    const store = als.getStore()
    if (!store) return undefined
    return store[key]
  },
)
