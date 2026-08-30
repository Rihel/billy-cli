export const templateTypes = ['package', 'client', 'service', 'crud'] as const

export type TemplateType = (typeof templateTypes)[number]

export interface CliOptions {
  type?: TemplateType
  name?: string
  install?: boolean
}

/** 单个 CRUD 字段定义 */
export interface CrudField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'text'
  required: boolean
  searchable: boolean
  unique?: boolean
}

export interface Template {
  /** 模块主目录（相对 workspaceRoot），生成物放在 directory/name 下 */
  directory: 'apps' | 'apps/server/src/modules' | 'packages'
  files: Record<string, string>
  /** 相对于 workspaceRoot 的额外文件（路径以 / 开头表示 workspace 根相对） */
  extraFiles?: Record<string, string>
}