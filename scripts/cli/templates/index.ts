import type { Template, TemplateType } from '../types.js'
import { createClientTemplate } from './client.js'
import { createPackageTemplate } from './package.js'
import { createServiceTemplate } from './service.js'
import { createCrudTemplate } from './crud.js'

export const templateLabels: Record<TemplateType, string> = {
  package: 'Package（通用 TypeScript 包）',
  client: 'Client（Next.js 前端应用）',
  service: 'Service（Hono 服务端应用）',
  crud: 'CRUD（Hono + TypeORM 业务模块）',
}

export function getTemplate(
  type: TemplateType,
  name: string,
): Promise<Template> | Template {
  if (type === 'package') return createPackageTemplate(name)
  if (type === 'client') return createClientTemplate(name)
  if (type === 'service') return createServiceTemplate(name)
  return createCrudTemplate(name)
}
