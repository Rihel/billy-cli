import { Inject, Injectable } from '@nestjs/common'
import { SessionStore, type SessionType } from '@repo/kits'
import type { SessionListModel, SuccessResultModel } from '@repo/shared'

/** 当前身份（前台用户或后台管理员）；鉴权关闭时无身份，传 null */
export interface SessionIdentity {
  type: SessionType
  sub: string
}

/**
 * 会话（登录设备）业务：
 *
 * 本模块**没有 repository** —— `SessionStore`（kits）本身就是会话的数据访问统一入口，
 * 再包一层仓储只是空转；service 只负责「身份 → 会话作用域」与响应整形。
 */
@Injectable()
export class SessionService {
  constructor(@Inject(SessionStore) private readonly sessionStore: SessionStore) {}

  /** 登录设备列表：按最后活跃倒序，标出当前会话 */
  async list(identity: SessionIdentity | null, currentToken?: string): Promise<SessionListModel> {
    // 鉴权关闭（AUTH_ENABLED=false）：没有用户体系也就没有会话，返回空列表而不是报错
    if (!identity) return { items: [], currentSessionId: null }

    const { entries, currentSessionId } = await this.sessionStore.list(
      identity.type,
      identity.sub,
      currentToken,
    )

    return {
      items: entries.map((entry) => ({
        ...entry,
        current: entry.sessionId === currentSessionId,
      })),
      currentSessionId,
    }
  }

  /**
   * 单设备下线（幂等）：会话已失效 / 不属于当前身份时也返回成功 ——
   * 语义与「登出幂等」一致，前端不必为「点慢了一步」处理报错。
   *
   * 越权保护：作用域固定为当前身份（`type` + `sub`），传别人的 sessionId 只会命中空结果。
   */
  async remove(identity: SessionIdentity | null, sessionId: string): Promise<SuccessResultModel> {
    if (identity) {
      await this.sessionStore.revokeById(identity.type, identity.sub, sessionId)
    }
    return { success: true }
  }
}
