/**
 * 执行面内部地址与令牌（**唯一读取处**）。
 *
 * 为什么允许直读 `process.env`：下游服务地址属于「装配期决定的可选依赖」，
 * 与 `AGENT_RUNTIME_URL` 的既有口径一致（`docs/guide/env.md`、`docs/guide/backend.md`
 * 把下游地址列为 env 例外）；运行期业务配置旋钮仍走 AppConfig。
 */
export interface AgentRuntimeEndpoint {
  baseUrl: string
  token: string
}

export const agentRuntimeEndpoint = (): AgentRuntimeEndpoint => ({
  baseUrl: process.env.AGENT_RUNTIME_URL?.trim() || 'http://127.0.0.1:9990',
  token: process.env.AGENT_INTERNAL_TOKEN?.trim() || '',
})
