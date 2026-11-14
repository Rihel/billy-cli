import { TOOL_CONTRACT_VERSION, type ToolManifest } from '@repo/contracts'
import type { z } from 'zod'
import { BASH_TOOL } from './tools/bash.js'
import { WEB_FETCH_TOOL } from './tools/web-fetch.js'
import { WEB_SEARCH_TOOL } from './tools/web-search.js'
import { MEMORY_FORGET_TOOL, MEMORY_SAVE_TOOL, MEMORY_SEARCH_TOOL } from './tools/memory.js'
import { READ_TOOL_RESULT_TOOL } from './tools/read-tool-result.js'
import { WEB_REQUEST_TOOL } from './tools/web-request.js'
import {
  APPEND_FILE_TOOL,
  FILE_DOWNLOAD_TOOL,
  FILE_LIST_TOOL,
  FILE_SEARCH_TOOL,
  FILE_SUBMIT_TOOL,
  READ_FILE_TOOL,
  REPLACE_FILE_TOOL,
  WORKSPACE_FILES_TOOL,
  WRITE_FILE_TOOL,
} from './tools/files.js'
import {
  SKILL_DELETE_TOOL,
  SKILL_ENABLE_TOOL,
  SKILL_FILE_APPEND_TOOL,
  SKILL_FILE_SAVE_TOOL,
  SKILL_IMPORT_TOOL,
  SKILL_LIST_TOOL,
  SKILL_SAVE_TOOL,
} from './tools/skills.js'

export { BASH_TOOL, BashParams } from './tools/bash.js'
export { WEB_FETCH_TOOL, WebFetchParams } from './tools/web-fetch.js'
export { WEB_SEARCH_TOOL, WebSearchParams } from './tools/web-search.js'
export {
  MEMORY_FORGET_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
  MemoryForgetInputSchema,
  MemorySaveInputSchema,
  MemorySearchInputSchema,
} from './tools/memory.js'
export { READ_TOOL_RESULT_TOOL, ReadToolResultParams } from './tools/read-tool-result.js'
export { WEB_REQUEST_TOOL, WebRequestParams } from './tools/web-request.js'
export {
  APPEND_FILE_TOOL,
  FILE_DOWNLOAD_TOOL,
  FILE_LIST_TOOL,
  FILE_SEARCH_TOOL,
  FILE_SUBMIT_TOOL,
  READ_FILE_TOOL,
  REPLACE_FILE_TOOL,
  WORKSPACE_FILES_TOOL,
  WRITE_FILE_TOOL,
  AppendFileInputSchema,
  DownloadInputSchema,
  FileSearchInputSchema,
  ListInputSchema,
  ReadFileInputSchema,
  ReplaceFileInputSchema,
  SubmitInputSchema,
  WorkspaceFilesInputSchema,
  WriteFileInputSchema,
} from './tools/files.js'
export {
  SKILL_DELETE_TOOL,
  SKILL_ENABLE_TOOL,
  SKILL_FILE_APPEND_TOOL,
  SKILL_FILE_SAVE_TOOL,
  SKILL_IMPORT_TOOL,
  SKILL_LIST_TOOL,
  SKILL_SAVE_TOOL,
  SkillDeleteParams,
  SkillEnableParams,
  SkillFileAppendParams,
  SkillFileSaveParams,
  SkillImportParams,
  SkillListParams,
  SkillSaveParams,
} from './tools/skills.js'
export { ALL_TOOL_MANIFESTS } from './generated.js'

export interface ToolDefinition<TParams extends z.ZodType = z.ZodType> {
  key: string
  title: string
  description: string
  category: string
  scope: 'all' | 'admin' | 'user' | 'agent'
  executor: string
  version: number
  params: TParams
}

/** **工具定义唯一清单**：server 声明与 gateway 目录都从这里取 */
export const TOOL_DEFINITIONS = [
  BASH_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_FORGET_TOOL,
  SKILL_LIST_TOOL,
  SKILL_SAVE_TOOL,
  SKILL_FILE_SAVE_TOOL,
  SKILL_FILE_APPEND_TOOL,
  SKILL_IMPORT_TOOL,
  SKILL_DELETE_TOOL,
  SKILL_ENABLE_TOOL,
  FILE_SUBMIT_TOOL,
  FILE_DOWNLOAD_TOOL,
  FILE_LIST_TOOL,
  READ_FILE_TOOL,
  FILE_SEARCH_TOOL,
  WORKSPACE_FILES_TOOL,
  WRITE_FILE_TOOL,
  REPLACE_FILE_TOOL,
  APPEND_FILE_TOOL,
  READ_TOOL_RESULT_TOOL,
  WEB_REQUEST_TOOL,
] as const

export const getToolDefinition = (key: string): ToolDefinition | undefined =>
  TOOL_DEFINITIONS.find((definition) => definition.key === key)

/** 定义 → 对模型 / 调用方公布的 manifest（参数转 JSON Schema，并补必填 reason） */
export const toToolManifest = (definition: ToolDefinition): ToolManifest => {
  const schema = definition.params.toJSONSchema() as {
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
  const properties = schema.properties ?? {}
  return {
    key: definition.key,
    title: definition.title,
    description: definition.description,
    category: definition.category,
    scope: definition.scope,
    executor: definition.executor,
    version: definition.version,
    params: {
      ...schema,
      properties: {
        ...properties,
        reason: {
          type: 'string',
          minLength: 1,
          description: '为什么用这个工具（必填）；网关会从业务入参里摘掉，不传给执行器',
        },
      },
      required: [...new Set([...(schema.required ?? []), 'reason'])],
    },
  }
}

export { TOOL_CONTRACT_VERSION }
