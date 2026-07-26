export const templateTypes = ['package', 'client', 'service'] as const

export type TemplateType = (typeof templateTypes)[number]

export interface CliOptions {
  type?: TemplateType
  name?: string
  install?: boolean
}

export interface Template {
  directory: 'apps' | 'packages'
  files: Record<string, string>
}