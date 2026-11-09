/**
 * 连接器状态来源（给网关插件用）—— 刻意做成一个**窄接口 + token**：
 * 插件在 `core/tools/plugins` 的邻居里，但不该知道仓储、驱动、同步这一整套东西。
 *
 * 实现方：`ConnectorService.stateOf`（带 5 秒缓存，见实现）。
 */
export const CONNECTOR_STATE_SOURCE = Symbol.for('ConnectorStateSource')

export interface ConnectorState {
  /** 实例是否启用（实例总闸） */
  enabled: boolean
  /** 必填密钥是否缺失（缺了调不了，但配置本身是合法的） */
  missingSecret: boolean
  /** 实例显示名（结论文案用） */
  name: string
  /**
   * 实例的密钥明文（只在内存里流转，**禁止落库 / 进日志**）。
   *
   * 为什么要放进状态：连接器的密钥在**实例**上，而网关的 `precheck` / `redact` 认的是
   * 工具设置里的密钥。guard 插件把这份密钥"嫁接"进本次调用的设置，
   * 于是「缺密钥」判定与「出参脱敏」都能正常工作（否则会误报"缺少密码"）。
   */
  secrets: Record<string, string>
}

export interface ConnectorStateSource {
  stateOf(connectorId: string): Promise<ConnectorState | null>
}
