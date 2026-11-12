import { z } from 'zod'
import { ToolCategory, ToolScope, ToolSource } from '../dicts/ai-tool.dict'
import { AiToolEventSchema } from './ai-tool-event.schema'
import { BasePaginateSchema } from './base.schema'

/**
 * 工具配置模块定义（`/ai-tool/*`，全部后台管理员鉴权）—— 设计 §5.5 / §5.11。
 *
 * 四条与表结构绑定的口径：
 * - **基础信息在代码、镜像入库**：`title` / `description` / `category` / `paramSchema` 由启动期的
 *   种子同步**全量覆盖**写入（代码声明是唯一事实源），页面只读展示，**不提供编辑入口**；
 * - **前端只配"配置"**：可改的只有开关 / 作用域 / 限额 / 配置值 / 秘钥；
 * - **秘钥明文入库**（工程取舍，2026-10-01 定）：表里存明文，接口只回**派生提示串**
 *   （`sk-…abcd`），日志与出参由 `redact` 插件脱敏；默认值来自代码（`defaultConfig`）；
 * - **runtime 工具只读**：Mastra 自带的技能工具进 `category='runtime'`，
 *   `update` / `reset` 对它们一律拒绝。
 */

const dateField = z.union([z.string(), z.date()]).optional()

/** 类别取值（字典是唯一事实源） */
export const ToolCategoryField = z.enum(
  ToolCategory.values as unknown as [string, ...string[]],
)
/** 作用域取值 */
export const ToolScopeField = z.enum(ToolScope.values as unknown as [string, ...string[]])
/** 来源取值 */
export const ToolSourceField = z.enum(ToolSource.values as unknown as [string, ...string[]])

/** 工具限额（`ai_tools.limits`）：null 表示"不限制 / 用默认" */
export const AiToolLimitsSchema = z
  .object({
    /** 每轮最多调用几次（null = 不限制） */
    maxPerTurn: z.number().int().positive().nullable().optional(),
    /** 时间窗限流 */
    rateLimit: z
      .object({
        windowSeconds: z.number().int().positive(),
        max: z.number().int().positive(),
      })
      .nullable()
      .optional(),
    /** 单次给模型的出参上限（字节）；null = 用代码里声明的值 */
    pageBytes: z.number().int().positive().nullable().optional(),
    /** 每轮最多取几页（防反复取页烧 token） */
    maxPagesPerTurn: z.number().int().positive().nullable().optional(),
  })
  .default({})

export type AiToolLimits = z.infer<typeof AiToolLimitsSchema>

/** 秘钥字段的元信息（前端据此渲染输入框；永不回明文） */
export const AiToolSecretFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  /** 必填的秘钥缺了就调不了（工具用 `precheck-failed` 结论告知模型） */
  required: z.boolean(),
  /** 已配置时的提示串（`sk-…abcd`）；未配置为 null */
  hint: z.string().nullable(),
})
export type AiToolSecretField = z.infer<typeof AiToolSecretFieldSchema>

/** 工具配置（对外模型） */
export const AiToolSchema = z.object({
  /** 工具 key（`tool-keys.ts` 的唯一事实源；表里是唯一键） */
  toolKey: z.string(),
  /** 标题（**代码声明的镜像**：启动期全量写入，页面只读） */
  title: z.string(),
  /** 说明（同上，代码声明的镜像） */
  description: z.string(),
  /** 见 `ToolCategory` 字典 */
  category: z.string(),
  /** 总开关 */
  enabled: z.boolean(),
  /** 见 `ToolScope` 字典 */
  scope: z.string(),
  /** `scope=agent` 时生效的 agent key 清单 */
  allowedAgents: z.array(z.string()),
  /** **哪些 agent 授权了它**（来自 agent 声明，DB 没有这份数据，服务端算） */
  agents: z.array(z.string()),
  /** 配置值（完整：库里的值 + 代码默认值补齐） */
  config: z.record(z.string(), z.unknown()),
  /** 代码默认值（`spec.config.parse({})`） */
  defaultConfig: z.record(z.string(), z.unknown()),
  /** 秘钥字段元信息（含已配置提示串；不含明文） */
  secretFields: z.array(AiToolSecretFieldSchema),
  limits: AiToolLimitsSchema,
  /** 见 `ToolSource` 字典 */
  source: z.string(),
  /** 参数定义的 JSON Schema（页面只读展示，便于核对"模型看到的入参长什么样"） */
  paramSchema: z.record(z.string(), z.unknown()).nullable(),
  /**
   * 自定义事件声明（**代码声明的镜像**，启动期全量写入，页面只读）：
   * 这个工具会在运行时往流里吐哪些事件、payload 长什么样。见 `ai-tool-event.schema.ts`。
   */
  events: z.array(AiToolEventSchema),
  /** 声明了分页才有值：单次给模型的默认字节上限 */
  pageBytes: z.number().int().positive().nullable(),
  /** 能否被后台改（runtime 工具为 false） */
  editable: z.boolean(),
  /** 最后一次在代码声明里出现的时间（"本次未见"看它） */
  lastSeenAt: dateField,
  updatedBy: z.string().nullable(),
  createdAt: dateField,
  updatedAt: dateField,
})

export type AiToolModel = z.infer<typeof AiToolSchema>

// ─────────────────────────── 管理台入参 ───────────────────────────

/** 列表：分页 + 可选筛选 */
export const AiToolListSchema = BasePaginateSchema.extend({
  /** 关键字（匹配 key 与标题） */
  keyword: z.string().max(64).optional(),
  category: ToolCategoryField.optional(),
  enabled: z.boolean().optional(),
  source: ToolSourceField.optional(),
})
export type AiToolListDto = z.infer<typeof AiToolListSchema>

/** 详情 / 恢复默认：工具 key */
export const AiToolKeySchema = z.object({ toolKey: z.string().min(1).max(64) })
export type AiToolKeyDto = z.infer<typeof AiToolKeySchema>

/**
 * 更新：只给要改的字段（省略 = 不改；`secrets` 里给空串 = 清空该秘钥）。
 *
 * `config` 与 `limits` 是**整列替换**（jsonb 不按 key 合并）—— 前端提交"整份生效配置"，
 * 这样"把某一项改回默认值"才表达得出来。
 */
export const AiToolUpdateSchema = z.object({
  toolKey: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  scope: ToolScopeField.optional(),
  allowedAgents: z.array(z.string().max(64)).max(50).optional(),
  /** 配置值（服务端按 `spec.config` 校验后落库；不含秘钥） */
  config: z.record(z.string(), z.unknown()).optional(),
  /** 秘钥（**明文入库**；省略 = 不改，空串 = 清空，给值 = 覆盖） */
  secrets: z.record(z.string(), z.string().max(4096)).optional(),
  limits: AiToolLimitsSchema.optional(),
})
export type AiToolUpdateDto = z.infer<typeof AiToolUpdateSchema>

// ─────────────────────── 执行环境（工作区运行时） ───────────────────────

/** 会话可选的沙箱文件权限（只读 / 可写） */
export const AiToolFileAccessSchema = z.enum(['read-only', 'workspace-write'])
export type AiToolFileAccess = z.infer<typeof AiToolFileAccessSchema>

/**
 * 当前部署的执行环境能力（管理页展示 / 校验提示用）。
 *
 * 这是**事实**而不是配置：能不能用沙箱由服务端探测决定，页面只读。
 */
export const AiToolWorkspaceStatusSchema = z.object({
  /**
   * 部署的隔离策略：`enforce` = 命令只能在沙箱里跑（不可用就拒绝）；
   * `off` = 不做隔离（仅自托管单租户）。
   */
  mode: z.enum(['enforce', 'off']),
  /** 会话可选的文件权限；`off` 时为空（没有隔离，也就没有权限可谈） */
  fileAccessOptions: z.array(AiToolFileAccessSchema),
  /** 沙箱探测结果 */
  sandbox: z.object({
    available: z.boolean(),
    /** 可用的实现（`available` 时） */
    impl: z.enum(['seatbelt', 'bwrap']).optional(),
    /** 不可用原因码 */
    code: z.string().optional(),
    /** 不可用原因（中文，可直接展示） */
    message: z.string().optional(),
  }),
})
export type AiToolWorkspaceStatusModel = z.infer<typeof AiToolWorkspaceStatusSchema>
