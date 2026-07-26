import type { Template, TemplateType } from '../types.js'
import { createClientTemplate } from './client.js'
import { createPackageTemplate } from './package.js'
import { createServiceTemplate } from './service.js'

export const templateLabels: Record<TemplateType, string> = {
  package: 'Package（通用 TypeScript 包）',
  client: 'Client（Next.js）',
  service: 'Service（NestJS 模块）',
}

export function getTemplate(type: TemplateType, name: string): Template {
  if (type === 'package') return createPackageTemplate(name)
  if (type === 'client') return createClientTemplate(name)
  return createServiceTemplate(name)
}
