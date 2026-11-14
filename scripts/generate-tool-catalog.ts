#!/usr/bin/env node
/**
 * 从 server 的 `@ToolDecl` 声明生成 gateway 用的全量工具清单。
 *
 * 为什么是生成而不是手抄：工具声明里有 Zod（参数 / 配置 / 事件）与长描述，
 * 手抄必然漂移。脚本只读装饰器元数据，**不实例化工具、不连 DB**。
 *
 * 用法：pnpm gen:tool-catalog
 * 产物：packages/tool-catalog/src/generated.ts（随代码提交）
 */
import 'reflect-metadata'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { z } from 'zod'
import type { ToolManifest } from '@repo/contracts'
import {
  TOOL_DECLS_KEY,
  TOOL_GROUP_KEY,
} from '../apps/agent-runtime/src/modules/ai/core/tools/tool.decorator.js'
import type {
  ToolDeclMeta,
  ToolGroupMeta,
} from '../apps/agent-runtime/src/modules/ai/core/tools/tool.decorator.js'
import { BashTool } from '../apps/agent-runtime/src/modules/ai/tools/bash.tool.js'
import { WebTools } from '../apps/agent-runtime/src/modules/ai/tools/web.tools.js'
import { FileTools } from '../apps/agent-runtime/src/modules/ai/files/file.tools.js'
import { SkillTools } from '../apps/agent-runtime/src/modules/ai/skills/skill.tools.js'
import { MemoryTools } from '../apps/agent-runtime/src/modules/ai/memory/memory.tools.js'
import { PlannerTools } from '../apps/agent-runtime/src/modules/ai/tools/planner/planner.tools.js'
import { RunSubAgentTool } from '../apps/agent-runtime/src/modules/ai/tools/subagent.tool.js'
import { ReadToolResultTool } from '../apps/agent-runtime/src/modules/ai/tools/read-tool-result.tool.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FACADE_KEYS = new Set([
  'plan-create',
  'plan-reorder',
  'plan-complete',
  'plan-delete',
  'run-sub-agent',
])
const WORKER_KEYS = new Set([
  'bash',
  'web-fetch',
  'web-search',
  'memory-save',
  'memory-search',
  'memory-forget',
  'file-submit',
  'file-download',
  'file-list',
  'read-file',
  'file-search',
  'workspace-files',
  'write-file',
  'replace-file',
  'append-file',
  'read-tool-result',
  'web-request',
])

const executorOf = (key: string): string => {
  if (FACADE_KEYS.has(key)) return 'facade'
  if (WORKER_KEYS.has(key)) return 'worker'
  return 'server'
}

const withReason = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const required = (schema.required ?? []) as string[]
  return {
    ...schema,
    properties: {
      ...properties,
      reason: {
        type: 'string',
        minLength: 1,
        description: '为什么用这个工具（必填）；网关会从业务入参里摘掉，不传给执行器',
      },
    },
    required: [...new Set([...required, 'reason'])],
  }
}

const classes = [
  BashTool,
  WebTools,
  FileTools,
  SkillTools,
  MemoryTools,
  PlannerTools,
  RunSubAgentTool,
  ReadToolResultTool,
]

const manifests: ToolManifest[] = []
for (const klass of classes) {
  const group = (Reflect.getMetadata(TOOL_GROUP_KEY, klass) as ToolGroupMeta | undefined) ?? {}
  const decls =
    (Reflect.getMetadata(TOOL_DECLS_KEY, klass) as Record<string, ToolDeclMeta> | undefined) ?? {}
  for (const decl of Object.values(decls)) {
    const params = (decl.params as z.ZodType).toJSONSchema() as Record<string, unknown>
    manifests.push({
      key: decl.key,
      title: decl.title,
      description: decl.description,
      category: decl.category ?? group.category ?? 'core',
      scope: decl.scope ?? group.scope ?? 'all',
      executor: executorOf(decl.key),
      params: withReason(params),
      version: 1,
    })
  }
}

manifests.sort((left, right) => left.key.localeCompare(right.key))

const output = `// 由 scripts/generate-tool-catalog.ts 生成，勿手改；改工具声明后跑 pnpm gen:tool-catalog
import type { ToolManifest } from '@repo/contracts'

/** 全量工具 manifest（含 facade / server / worker 三种执行方） */
export const ALL_TOOL_MANIFESTS: readonly ToolManifest[] = ${JSON.stringify(manifests, null, 2)} as const
`

await writeFile(resolve(__dirname, '../packages/tool-catalog/src/generated.ts'), output, 'utf8')
console.log(`[gen:tool-catalog] 写入 ${manifests.length} 个工具定义`)
