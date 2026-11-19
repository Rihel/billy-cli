import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AiToolEntity } from '@repo/db'
import type { AppLogger, WorkspaceRuntimeService } from '@repo/kits'
import type {
  ToolAdminCatalog,
  ToolAdminSpec,
} from '../src/modules/ai-admin/tool/tool-admin.catalog.js'
import type {
  AiToolAdminRepositoryPort,
  AiToolAdminResetValues,
  AiToolAdminUpdatePatch,
} from '../src/modules/ai-admin/tool/tool-admin.repository.js'
import { AiToolAdminService } from '../src/modules/ai-admin/tool/tool-admin.service.js'

/**
 * `/ai-tool/update` 的单测：**秘钥明文绝不回前端**。
 *
 * 只测这一条口径：造一行含明文秘钥的 `ai_tools`，走 service.update，断言出参只有
 * `hintOf` 派生的提示串、序列化后的响应体里找不到明文。fake repository 不连库。
 */

const PLAINTEXT = 'sk-test-super-secret-1234'

const spec: ToolAdminSpec = {
  key: 'web-search',
  title: '搜索网页（先找来源，再读）',
  description: '搜索网页，返回来源清单',
  category: 'core',
  scope: 'all',
  config: z.object({ enabled: z.boolean().default(true) }),
  secrets: z.object({ apiKey: z.string().min(1).optional() }),
  secretFields: [{ name: 'apiKey', label: 'DeepSeek API Key' }],
  paramSchema: null,
  pageBytes: null,
  editable: true,
  runtime: false,
}

const row = (over: Partial<AiToolEntity> = {}): AiToolEntity =>
  ({
    id: 'tool-1',
    toolKey: 'web-search',
    title: '搜索网页（先找来源，再读）',
    description: '搜索网页，返回来源清单',
    category: 'core',
    enabled: true,
    scope: 'all',
    allowedAgents: null,
    config: { enabled: true },
    secrets: { apiKey: PLAINTEXT },
    limits: null,
    source: 'manual',
    paramSchema: null,
    events: [],
    lastSeenAt: new Date('2026-11-14T00:00:00.000Z'),
    createdBy: null,
    updatedBy: 'admin-1',
    deletedBy: null,
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    updatedAt: new Date('2026-11-14T00:00:00.000Z'),
    deletedAt: null,
    ...over,
  }) as AiToolEntity

/** 内存仓储：只实现端口要求的五个方法，行为与真实仓储的合并 / 清空口径一致 */
class FakeRepository implements AiToolAdminRepositoryPort {
  constructor(public current: AiToolEntity) {}

  async listAll(): Promise<AiToolEntity[]> {
    return [this.current]
  }

  async findByKey(toolKey: string): Promise<AiToolEntity | null> {
    return this.current.toolKey === toolKey ? this.current : null
  }

  async createSeed(_spec: ToolAdminSpec): Promise<AiToolEntity> {
    return this.current
  }

  async update(_toolKey: string, patch: AiToolAdminUpdatePatch): Promise<AiToolEntity> {
    const { secrets, ...rest } = patch
    const merged = { ...this.current.secrets }
    if (secrets) {
      for (const [name, value] of Object.entries(secrets)) {
        if (value === '') delete merged[name]
        else merged[name] = value
      }
    }
    this.current = Object.assign({}, this.current, rest, {
      ...(secrets !== undefined ? { secrets: Object.keys(merged).length > 0 ? merged : null } : {}),
      updatedAt: new Date(),
    }) as AiToolEntity
    return this.current
  }

  async reset(_toolKey: string, values: AiToolAdminResetValues): Promise<AiToolEntity> {
    this.current = Object.assign({}, this.current, {
      enabled: true,
      scope: values.scope,
      allowedAgents: null,
      config: values.config,
      limits: null,
      secrets: null,
      source: 'seed',
    }) as AiToolEntity
    return this.current
  }
}

const workspace = {
  status: async () => ({
    mode: 'off' as const,
    fileAccessOptions: [],
    sandbox: {
      available: false,
      reason: { code: 'sandbox-unavailable', message: '测试环境不探测沙箱' },
      probedAt: new Date().toISOString(),
    },
  }),
} as unknown as WorkspaceRuntimeService

const logger = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger

describe('AiToolAdminService.update（秘钥不出明文）', () => {
  it('只返回提示串，响应体里不含明文秘钥', async () => {
    const repository = new FakeRepository(row())
    const catalog = {
      specs: async () => [spec],
      find: async (key: string) => (key === spec.key ? spec : undefined),
    } as unknown as ToolAdminCatalog
    const service = new AiToolAdminService(repository, workspace, logger, catalog)

    const result = await service.update({ toolKey: 'web-search', enabled: false })

    expect(result.enabled).toBe(false)
    expect(result.secretFields).toHaveLength(1)
    expect(result.secretFields[0]?.hint).toBe('sk-…1234')
    expect(result.secretFields[0]?.hint).not.toBe(PLAINTEXT)
    // 整个响应体（含嵌套对象）都不能出现明文
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT)
    // 出参里没有 secrets 字段（明文只允许留在库里）
    expect(Object.prototype.hasOwnProperty.call(result, 'secrets')).toBe(false)

    // 库里的明文没有被接口调用改写（更新的是开关，不是秘钥）
    expect(repository.current.secrets?.apiKey).toBe(PLAINTEXT)
  })
})
