import type { CanActivate, ExecutionContext } from '@nestjs/common'

/**
 * 「任一身份通过即可」的守卫编排助手（纯逻辑，不 import 任何业务模块）。
 *
 * 用途：工程里有互不相通的两套身份体系（前台用户 `UserAuthGuard` / 后台管理员
 * `AdminAuthGuard`），而部分能力对**两端都要开放**（对象存储上传、会话管理、SSE 订阅）。
 * 单身份守卫做不到，二选一配置又会让另一半完全不可用。
 *
 * 语义：
 * - 依次尝试，**任一通过即放行**（通过的守卫已把身份写入请求上下文 ALS）；
 * - 全失败时抛**最后一个**守卫的异常 —— 与单身份模式的错误语义一致（401 而不是笼统 403）。
 *
 * 注意：本函数只负责「有没有身份」，**不区分是哪种身份**；调用方需要按身份分域时，
 * 读 `requestContext.get('userId')` / `requestContext.get('adminId')` 自行判断。
 */
export const anyOfGuards = async (
  guards: CanActivate[],
  context: ExecutionContext,
): Promise<boolean> => {
  let lastError: unknown
  for (const guard of guards) {
    try {
      if (await guard.canActivate(context)) return true
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return false
}
