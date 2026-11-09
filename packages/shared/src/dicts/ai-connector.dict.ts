import { createDict } from '../utils'

/**
 * 连接器的字典（设计 `docs/design/ai-connector.md` §3.2 / §3.4）。
 *
 * 三个术语先说清：
 * - **连接器** = 一条可配置的「外部能力来源」，属于数据；
 * - **驱动** = 一种接法（sql / redis / mcp-http / rest），属于代码；
 * - **状态** = **上次测试的结论**，不是实时连接状态（本期不做常驻会话，见设计 §3.7）。
 */

/** 连接器的可用状态：只表示"上次测试怎么样" */
export const ConnectorStatus = createDict({
  Unknown: { label: '未验证', value: 'unknown' },
  Ok: { label: '可用', value: 'ok' },
  Error: { label: '不可用', value: 'error' },
})

/** 来源：内置目录里的型号，还是管理员自己加的 */
export const ConnectorKind = createDict({
  Builtin: { label: '内置', value: 'builtin' },
  Custom: { label: '自定义', value: 'custom' },
})

/** 传输形态（只给页面筛选用，见设计 §2.7） */
export const ConnectorTransport = createDict({
  Http: { label: 'HTTP', value: 'http' },
  Db: { label: '数据库', value: 'db' },
  Process: { label: '命令行', value: 'process' },
  None: { label: '无', value: 'none' },
})

/** 基础层授权：不要 / 填密钥 */
export const ConnectorAuthBase = createDict({
  None: { label: '不需要', value: 'none' },
  Secret: { label: '密钥', value: 'secret' },
})

/** 主体层授权：不要 / 用户授权（二期） */
export const ConnectorAuthSubject = createDict({
  None: { label: '不需要', value: 'none' },
  OAuth: { label: '用户授权', value: 'oauth' },
})

/**
 * 工具来源：代码声明 / 连接器。
 *
 * 与 `ToolSource` 是两条轴：`ToolSource` 记"配置是谁改的"（seed / manual），
 * 这里记"工具从哪来"。混成一列会让种子同步的判定变复杂（设计 §3.2）。
 */
export const ToolOrigin = createDict({
  Code: { label: '代码声明', value: 'code' },
  Connector: { label: '连接器', value: 'connector' },
})
