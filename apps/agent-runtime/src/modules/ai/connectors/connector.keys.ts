/**
 * 工具 key 的拼接与校验（设计 `docs/design/ai-connector.md` §3.5）。
 *
 * 三条口径：
 * - 格式 `c-<实例 key>-<工具名>`，全小写、非 `[a-z0-9-]` 换成 `-`、连续合并、总长 ≤ 64
 *   （受 `ai_tools.tool_key` 的 varchar(64) 约束）；
 * - **只当可读约定，不做反向解析**：实例 key 与工具名都含 `-`，反解必然有歧义；
 *   追溯一律查 `ai_tools.connector_id`；
 * - 归一化后为空 → 用 `tool` 兜底，避免拼出 `c-foo-` 这种尾巴。
 */

/** 归一化一段 key：小写、非法字符换连字符、去首尾连字符 */
export const normalizeKeyPart = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

/** 连接器产出的工具 key：`c-<实例 key>-<工具名>`，截到 64 位 */
export const connectorToolKey = (connectorKey: string, toolName: string): string => {
  const name = normalizeKeyPart(toolName) || 'tool'
  const raw = `c-${connectorKey}-${name}`
  return raw.length <= 64 ? raw : raw.slice(0, 64).replace(/-+$/, '')
}

/** 实例 key 是否合法（与 `ConnectorKeySchema` 同口径） */
export const isValidConnectorKey = (key: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 32
