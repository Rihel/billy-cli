import type { McpDiscoverResult, McpTool } from '@repo/contracts'
import { UnsafeTargetError, allowPrivateNetworkOf, assertSafeTarget } from './target.guard.js'

/**
 * **MCP 适配器（网关作为 client）**：Streamable HTTP + JSON-RPC 2.0。
 *
 * 只做三件事：`initialize` 握手（拿 `Mcp-Session-Id`）、`tools/list`（分页拉全）、
 * `tools/call`（按原始工具名调用）。stdio 需要本地进程适配器，v1 不做；SSE 长连接也不做——
 * 每次调用一次 POST、一次响应。
 *
 * 映射口径：
 * - MCP 工具名可能带 `_` / 大写，归一成能力协议要求的扁平 key（`flattenToolName`），
 *   原名存进 `remoteTool`，调用时原样传回；
 * - `isError: true` → 业务失败（`mcp-tool-error`），否则把 `result` 原样作为 data；
 * - 会话按 URL 缓存 5 分钟，过期后重新握手（连接器 / 服务重启都不会 500）。
 */

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'billy-capability-gateway', version: '0.1.0' }
const REQUEST_TIMEOUT_MS = 10_000
const SESSION_TTL_MS = 5 * 60_000
const MAX_PAGES = 10
const MAX_TOOL_NAME = 32

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

interface McpEndpoint {
  url: string
  headers?: Record<string, string>
  allowHttp: boolean
  allowPrivateNetwork?: boolean
  /** 单次请求超时（毫秒）：发现默认 10s；invoke 按调用 deadline 传 */
  timeoutMs?: number
}

interface Session {
  id?: string
  at: number
}

const sessions = new Map<string, Session>()
/** 每个端点协商到的协议版本（`MCP-Protocol-Version` 头用它；没握手就用默认） */
const versions = new Map<string, string>()
let idSeq = 0

/** MCP 工具名 → 能力协议的扁平 key（`[a-z0-9-]`，≤32） */
export const flattenToolName = (raw: string): string => {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const trimmed = base.slice(0, MAX_TOOL_NAME)
  return /^[a-z0-9]/.test(trimmed) ? trimmed : `tool-${trimmed}`.slice(0, MAX_TOOL_NAME)
}

const assertTarget = async (endpoint: McpEndpoint): Promise<void> => {
  try {
    await assertSafeTarget(endpoint.url, {
      allowHttp: endpoint.allowHttp,
      allowPrivateNetwork: endpoint.allowPrivateNetwork ?? allowPrivateNetworkOf(undefined),
    })
  } catch (error) {
    if (error instanceof UnsafeTargetError) throw new McpError(error.message)
    throw error
  }
}

/** 解析响应：普通 JSON，或 `text/event-stream`（取最后一条带 result / error 的 data） */
const parsePayload = async (
  response: Response,
): Promise<{ result?: Record<string, unknown>; error?: { code?: number; message?: string } }> => {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    let found: ReturnType<typeof JSON.parse> | null = null
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      try {
        const parsed = JSON.parse(line.slice(5).trim())
        if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) found = parsed
      } catch {
        // 忽略非 JSON 的心跳 / 注释行
      }
    }
    if (!found) throw new McpError('MCP 的 SSE 响应里没有结果')
    return found
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: Record<string, unknown>
    error?: { code?: number; message?: string }
  } | null
  if (!payload) throw new McpError('MCP 响应不是合法 JSON')
  return payload
}

const rpc = async (
  endpoint: McpEndpoint,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; sessionId?: string }> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    // 新版本（2026-07-28 起）要求每个 POST 都带；旧版本忽略这个头
    'mcp-protocol-version': versions.get(endpoint.url) ?? PROTOCOL_VERSION,
    ...endpoint.headers,
  }
  const session = sessions.get(endpoint.url)
  if (session && Date.now() - session.at < SESSION_TTL_MS && session.id) {
    headers['mcp-session-id'] = session.id
  }
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++idSeq,
      method,
      ...(params === undefined ? {} : { params }),
    }),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? REQUEST_TIMEOUT_MS),
  })
  const sessionId = response.headers.get('mcp-session-id') ?? undefined
  if (!response.ok) {
    throw new McpError(`MCP 端点返回 ${response.status}`, response.status)
  }
  const payload = await parsePayload(response)
  if (payload.error) {
    throw new McpError(payload.error.message ?? 'MCP 返回错误', payload.error.code)
  }
  return {
    ...(payload.result === undefined ? {} : { result: payload.result }),
    ...(sessionId ? { sessionId } : {}),
  }
}

const initialize = async (endpoint: McpEndpoint): Promise<string> => {
  let result: Record<string, unknown> | undefined
  let sessionId: string | undefined
  try {
    const init = await rpc(endpoint, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    result = init.result
    sessionId = init.sessionId
  } catch (error) {
    // 2026-07-28 版协议移除了 initialize / 会话：对方回「方法不存在 / 405」时按无状态继续
    const stateless =
      error instanceof McpError &&
      (error.code === -32601 || error.code === 404 || error.code === 405)
    if (!stateless) throw error
    sessions.set(endpoint.url, { at: Date.now() })
    return PROTOCOL_VERSION
  }
  sessions.set(endpoint.url, { ...(sessionId ? { id: sessionId } : {}), at: Date.now() })
  if (typeof result?.protocolVersion === 'string')
    versions.set(endpoint.url, result.protocolVersion)
  // 握手后的通知（规范要求；对方回 202 / 无响应都算成功）
  await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...endpoint.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? REQUEST_TIMEOUT_MS),
  }).catch(() => undefined)
  return typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION
}

const toTool = (raw: unknown, used: Set<string>): McpTool | null => {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const remoteTool = typeof record.name === 'string' ? record.name.trim() : ''
  if (!remoteTool) return null
  let key = flattenToolName(remoteTool)
  let suffix = 2
  while (used.has(key)) {
    const tail = `-${suffix++}`
    key = `${key.slice(0, MAX_TOOL_NAME - tail.length)}${tail}`
  }
  used.add(key)
  const description =
    typeof record.description === 'string' && record.description.trim()
      ? record.description.trim().slice(0, 900)
      : remoteTool
  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim().slice(0, 64)
      : remoteTool.slice(0, 64)
  const inputSchema =
    record.inputSchema &&
    typeof record.inputSchema === 'object' &&
    !Array.isArray(record.inputSchema)
      ? (record.inputSchema as Record<string, unknown>)
      : { type: 'object' }
  return { key, remoteTool, title, description, inputSchema }
}

/** 发现一个 MCP server 的全部工具（握手 + tools/list 分页） */
export const discoverMcpTools = async (input: McpEndpoint): Promise<McpDiscoverResult> => {
  await assertTarget(input)
  const protocolVersion = await initialize(input)
  const used = new Set<string>()
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { result } = await rpc(input, 'tools/list', cursor === undefined ? {} : { cursor })
    const list = Array.isArray(result?.tools) ? result.tools : []
    for (const item of list) {
      const tool = toTool(item, used)
      if (tool) tools.push(tool)
    }
    cursor =
      typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
    if (!cursor) break
  }
  return { protocolVersion, tools }
}

export type McpCallResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: string; message: string; retryable: boolean }

const textOf = (result: Record<string, unknown> | undefined): string => {
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** 调用一个 MCP 工具（懒握手：没有有效会话就先 initialize） */
export const callMcpTool = async (
  input: McpEndpoint & { remoteTool: string; args: Record<string, unknown> },
): Promise<McpCallResult> => {
  try {
    await assertTarget(input)
    const session = sessions.get(input.url)
    if (!session || Date.now() - session.at >= SESSION_TTL_MS) await initialize(input)
    const { result } = await rpc(input, 'tools/call', {
      name: input.remoteTool,
      arguments: input.args,
    })
    if (result?.isError === true) {
      return {
        ok: false,
        reason: 'mcp-tool-error',
        message: textOf(result) || 'MCP 工具返回错误',
        retryable: false,
      }
    }
    return { ok: true, data: result ?? {} }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retryable = error instanceof McpError && error.code !== undefined && error.code >= 500
    return { ok: false, reason: 'upstream', message: `MCP 调用失败：${message}`, retryable }
  }
}
