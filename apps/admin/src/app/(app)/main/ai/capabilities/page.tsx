'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  AiToolModel,
  AiToolUpdateDto,
  CapabilityServiceCapabilityDto,
  CapabilityServiceModel,
  CapabilityServiceProtocol,
  CapabilityServiceSaveDto,
} from '@repo/shared'
import {
  Button,
  cn,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  JsonView,
  Label,
  PageToolbar,
  SegmentedControl,
  Switch,
  Tag,
  Textarea,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { PlusIcon, RotateCwIcon, WrenchIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { ToolFormModal } from '../tools/tool-form'

/**
 * 能力服务（`/main/ai/capabilities`）—— 内部实例的登记目录 + 外部服务的登记入口。
 *
 * 页面口径：
 * 1. 服务卡片按**类型**给操作：内部（code）只有启停（编辑会改成 manual、删除会被 registrar 补登，
 *    都是假操作）；外部（manual）才有编辑 / 测试连通 / 删除；
 * 2. **能力只能同步不能手填**：能力是对方服务的事实，手填必漂移；
 * 3. 登记表单按**原生协议**联动：能力协议填 baseUrl / 探活 / 鉴权；MCP 改填标准配置 JSON，
 *    保存时从配置派生 baseUrl / header / 凭据；
 * 4. MCP 适配器待建：页面明示「握手与工具清单同步暂不可用」，不造假能力。
 */

/** MCP 标准配置模板（`{url, headers}`；也兼容 `mcpServers` 包裹） */
const MCP_TEMPLATE = JSON.stringify(
  { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer <token>' } },
  null,
  2,
)

/** 表单里能力清单只读：由「同步能力清单」从对方 `/manifest` 写回 */
const emptyForm = (): FormState => ({
  protocol: 'capability',
  service: '',
  title: '',
  owner: '',
  baseUrl: '',
  healthPath: '/healthz',
  authHeader: 'x-api-key',
  credential: '',
  mcpConfig: MCP_TEMPLATE,
  capabilities: [],
})

interface FormState {
  protocol: CapabilityServiceProtocol
  service: string
  title: string
  owner: string
  baseUrl: string
  healthPath: string
  authHeader: string
  credential: string
  mcpConfig: string
  capabilities: CapabilityServiceCapabilityDto[]
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface McpEndpoint {
  /** 完整 MCP 端点（同步 / 保存自检用） */
  url: string
  /** 全部配置头（同步时原样带给网关） */
  headers: Record<string, string>
  /** 网关调用与探活的基地址（MCP url 的 origin） */
  baseUrl: string
  /** 探活路径（MCP url 的 path + query） */
  healthPath: string
  /** 出站鉴权 header 名（取 headers 里第一个有值的键） */
  header: string
  credential?: string
}

/**
 * 解析 MCP 标准配置。
 *
 * 兼容两种形状：裸的 `{url, headers}`，或 `{mcpServers: {...}}` 包裹（取第一个服务）。
 * stdio 型（`command` / `type: 'stdio'`）需要本地适配器，直接拒收并说明原因。
 */
const parseMcpConfig = (text: string): McpEndpoint => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('MCP 配置不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('MCP 配置必须是 JSON 对象')
  }
  const record = raw as Record<string, unknown>
  const wrapped = record.mcpServers
  const entry =
    wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
      ? Object.values(wrapped as Record<string, unknown>)[0]
      : raw
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('MCP 配置里没有可用的服务条目')
  }
  const server = entry as Record<string, unknown>
  if (server.command !== undefined || server.type === 'stdio') {
    throw new Error('stdio 型 MCP 需要本地适配器，暂不支持；请填 url 型（http / sse）')
  }
  const url = typeof server.url === 'string' ? server.url.trim() : ''
  if (!url) throw new Error('MCP 配置缺少 url')
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new Error(`MCP 配置的 url 不合法：${url}`)
  }
  const headers: Record<string, string> = {}
  if (server.headers !== undefined) {
    if (!server.headers || typeof server.headers !== 'object' || Array.isArray(server.headers)) {
      throw new Error('MCP 配置的 headers 必须是对象')
    }
    for (const [name, value] of Object.entries(server.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[name] = value
    }
  }
  const firstHeader = Object.entries(headers).find(([, value]) => value.trim() !== '')
  return {
    url: target.toString(),
    headers,
    baseUrl: target.origin,
    healthPath: `${target.pathname}${target.search}` || '/',
    header: firstHeader?.[0] ?? 'authorization',
    ...(firstHeader ? { credential: firstHeader[1] } : {}),
  }
}

/** 把对方 `/manifest` 里的一条能力归一到后台登记所需的形状 */
const normalizeCapability = (raw: unknown): CapabilityServiceCapabilityDto => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('能力条目必须是对象')
  }
  const record = raw as Record<string, unknown>
  const tool =
    typeof record.tool === 'string' && record.tool
      ? record.tool
      : typeof record.name === 'string'
        ? record.name
        : ''
  if (!tool) throw new Error('能力条目缺少 tool / name')
  const title = typeof record.title === 'string' && record.title ? record.title : tool
  const description =
    typeof record.description === 'string' && record.description ? record.description : title
  return {
    tool,
    title,
    description,
    inputSchema:
      record.inputSchema &&
      typeof record.inputSchema === 'object' &&
      !Array.isArray(record.inputSchema)
        ? (record.inputSchema as Record<string, unknown>)
        : { type: 'object' },
    risk: record.risk === 'write' ? 'write' : 'read',
  }
}

/** 兼容 `{capabilities: [...]}` 与裸数组两种清单形状 */
const extractCapabilities = (manifest: unknown): CapabilityServiceCapabilityDto[] => {
  const list = Array.isArray(manifest)
    ? manifest
    : manifest &&
        typeof manifest === 'object' &&
        Array.isArray((manifest as { capabilities?: unknown }).capabilities)
      ? (manifest as { capabilities: unknown[] }).capabilities
      : null
  if (!list) throw new Error('对方 /manifest 里没有能力清单（要 capabilities 数组或裸数组）')
  return list.map(normalizeCapability)
}

/** 参数说明：JSON Schema 的 properties → 人话（类型 / 必填 / 默认值） */
interface ParamRow {
  name: string
  type: string
  required: boolean
  description?: string
  defaultValue?: string
}

const TYPE_LABELS: Record<string, string> = {
  string: '文本',
  number: '数字',
  integer: '整数',
  boolean: '布尔',
  array: '数组',
  object: '对象',
  null: '空值',
}

const humanType = (property: Record<string, unknown>): string => {
  if (Array.isArray(property.enum)) {
    return `枚举（${property.enum.map((item) => String(item)).join(' / ')}）`
  }
  if (typeof property.type === 'string') return TYPE_LABELS[property.type] ?? property.type
  if (Array.isArray(property.type)) {
    return property.type.map((item) => TYPE_LABELS[String(item)] ?? String(item)).join(' | ')
  }
  return '任意'
}

/** 非 object schema（没有 properties）返回 null，交给 JsonView 兜底 */
const schemaParams = (schema: Record<string, unknown>): ParamRow[] | null => {
  if (
    schema.type !== 'object' ||
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  ) {
    return null
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  )
  return Object.entries(schema.properties as Record<string, unknown>).map(([name, raw]) => {
    const property =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    return {
      name,
      type: humanType(property),
      required: required.has(name),
      ...(typeof property.description === 'string' && property.description
        ? { description: property.description }
        : {}),
      ...(property.default === undefined ? {} : { defaultValue: JSON.stringify(property.default) }),
    }
  })
}

const statusTag = (service: CapabilityServiceModel) => {
  if (service.status === 'active') return <Tag color="success">启用</Tag>
  if (service.status === 'draft') return <Tag color="warning">草稿</Tag>
  return <Tag>停用</Tag>
}

const protocolTag = (service: CapabilityServiceModel) => {
  if (service.source === 'code') return <Tag>内部 · 能力协议</Tag>
  return service.protocol === 'mcp' ? (
    <Tag color="warning">外部 · MCP</Tag>
  ) : (
    <Tag color="processing">外部 · 自建协议</Tag>
  )
}

const probeTag = (service: CapabilityServiceModel) => {
  const state = service.probe?.state
  if (state === 'up') return <Tag color="success">探活正常</Tag>
  if (state === 'down') return <Tag color="error">探活失败</Tag>
  return <Tag>未探活</Tag>
}

export default function CapabilitiesPage() {
  const client = useServerClient()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CapabilityServiceModel | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  /** 能力清单弹窗：查看哪个服务、选中哪个能力 */
  const [inspecting, setInspecting] = useState<CapabilityServiceModel | null>(null)
  const [inspectTool, setInspectTool] = useState<string | null>(null)
  /** 工具级配置（服务详情里直接编辑，不再单独去「工具配置」页） */
  const [toolEditing, setToolEditing] = useState<AiToolModel | null>(null)
  const [toolFormOpen, setToolFormOpen] = useState(false)
  const [runtimeToolsOpen, setRuntimeToolsOpen] = useState(false)
  /** 服务筛选：全部 / MCP / 内部（code）/ 外部（manual 能力协议） */
  const [serviceFilter, setServiceFilter] = useState<'all' | 'mcp' | 'internal' | 'external'>('all')

  const listQuery = useQuery({
    queryKey: ['capabilityService', 'list'],
    queryFn: () => client.capabilityService.list({}),
  })

  const saveMutation = useMutation({
    mutationFn: (dto: CapabilityServiceSaveDto) => client.capabilityService.save(dto),
  })
  const aiToolsQuery = useQuery({
    queryKey: ['aiTool', 'list', 'all'],
    queryFn: () => client.aiTool.list({ page: 1, size: 100 }),
  })
  const workspaceQuery = useQuery({
    queryKey: ['aiTool', 'workspace'],
    queryFn: () => client.aiTool.workspace(),
    staleTime: 5 * 60 * 1000,
  })
  const updateToolMutation = useMutation({
    mutationFn: (dto: AiToolUpdateDto) => client.aiTool.update(dto),
  })
  const resetToolMutation = useMutation({
    mutationFn: (input: { toolKey: string }) => client.aiTool.reset(input),
  })
  const removeMutation = useMutation({
    mutationFn: (service: string) => client.capabilityService.remove({ service }),
  })
  const statusMutation = useMutation({
    mutationFn: (input: { service: string; status: 'active' | 'disabled' }) =>
      client.capabilityService.status(input),
  })
  const testMutation = useMutation({
    mutationFn: (input: { baseUrl: string; healthPath: string }) =>
      client.capabilityService.test(input),
  })
  const pullMutation = useMutation({
    mutationFn: (input: { baseUrl: string; healthPath: string }) =>
      client.capabilityService.pullManifest(input),
  })
  const pullMcpMutation = useMutation({
    mutationFn: (input: { url: string; headers: Record<string, string>; allowHttp: boolean }) =>
      client.capabilityService.pullMcp(input),
  })

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setFormOpen(true)
  }

  const openEdit = (service: CapabilityServiceModel) => {
    setEditing(service)
    setForm({
      protocol: service.protocol,
      service: service.service,
      title: service.title,
      owner: service.owner,
      baseUrl: service.baseUrl ?? '',
      healthPath: service.healthPath,
      authHeader: 'x-api-key',
      credential: '',
      mcpConfig:
        service.protocol === 'mcp'
          ? JSON.stringify(
              {
                url:
                  service.healthPath === '/'
                    ? (service.baseUrl ?? '')
                    : `${service.baseUrl ?? ''}${service.healthPath}`,
                headers: {},
              },
              null,
              2,
            )
          : MCP_TEMPLATE,
      // 回填时原样保留 inputSchema，不退成空对象
      capabilities: service.capabilities,
    })
    setFormOpen(true)
  }

  const openInspect = (service: CapabilityServiceModel) => {
    setInspecting(service)
    setInspectTool(service.capabilities[0]?.tool ?? null)
  }

  const toggleStatus = async (service: CapabilityServiceModel, enabled: boolean) => {
    try {
      await statusMutation.mutateAsync({
        service: service.service,
        status: enabled ? 'active' : 'disabled',
      })
      await listQuery.refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const removeService = async (service: string) => {
    try {
      await removeMutation.mutateAsync(service)
      toastSuccess('已删除')
      await listQuery.refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  /** 列表上的测试连通：直接测已登记服务的端点（不打开表单） */
  const testService = async (service: CapabilityServiceModel) => {
    try {
      if (!service.baseUrl) throw new Error('这个服务没有 baseUrl 可测')
      const result = await testMutation.mutateAsync({
        baseUrl: service.baseUrl,
        healthPath: service.healthPath,
      })
      if (service.protocol === 'mcp') {
        if (result.status !== undefined) toastSuccess('网络可达；MCP 握手由保存时的自检完成')
        else toastError(result.message ?? '连不上')
        return
      }
      if (result.ok) toastSuccess('连通正常')
      else toastError(result.message ?? '连不上')
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  /** 表单当前的探活端点：MCP 从配置 JSON 派生，能力协议直接用填的 */
  const endpointOf = (): { baseUrl: string; healthPath: string } => {
    if (form.protocol === 'mcp') {
      const mcp = parseMcpConfig(form.mcpConfig)
      return { baseUrl: mcp.baseUrl, healthPath: mcp.healthPath }
    }
    return { baseUrl: form.baseUrl.trim(), healthPath: form.healthPath.trim() || '/healthz' }
  }

  const testConnection = async () => {
    try {
      const endpoint = endpointOf()
      if (!endpoint.baseUrl) throw new Error('先填 baseUrl')
      const result = await testMutation.mutateAsync(endpoint)
      if (form.protocol === 'mcp') {
        // 有 HTTP 响应就算网络可达；MCP 握手要等适配器
        if (result.status !== undefined) toastSuccess('网络可达；MCP 握手由保存时的自检完成')
        else toastError(result.message ?? '连不上')
        return
      }
      if (result.ok) toastSuccess('连通正常')
      else toastError(result.message ?? '连不上')
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const syncCapabilities = async () => {
    try {
      if (form.protocol === 'mcp') {
        const mcp = parseMcpConfig(form.mcpConfig)
        const tools = await pullMcpMutation.mutateAsync({
          url: mcp.url,
          headers: mcp.headers,
          allowHttp: mcp.url.startsWith('http://'),
        })
        if (tools.length === 0) throw new Error('MCP server 没有列出任何工具')
        setForm((current) => ({ ...current, capabilities: tools }))
        toastSuccess(`已同步 ${tools.length} 个工具，保存后生效`)
        return
      }
      const endpoint = endpointOf()
      if (!endpoint.baseUrl) throw new Error('先填 baseUrl')
      const manifest = await pullMutation.mutateAsync(endpoint)
      const capabilities = extractCapabilities(manifest)
      if (capabilities.length === 0) throw new Error('对方 /manifest 里的能力清单是空的')
      setForm((current) => ({ ...current, capabilities }))
      toastSuccess(`已同步 ${capabilities.length} 个能力，保存后生效`)
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const submit = async () => {
    try {
      if (!form.service.trim()) throw new Error('服务名必填')
      if (!form.title.trim()) throw new Error('标题必填')
      if (!form.owner.trim()) throw new Error('负责人必填')
      if (form.capabilities.length === 0) {
        throw new Error(
          form.protocol === 'mcp'
            ? '能力清单为空：先点「同步能力清单」从 MCP server 拉取'
            : '能力清单为空：先点「同步能力清单」从对方 /manifest 拉取',
        )
      }

      let baseUrl = form.baseUrl.trim()
      let healthPath = form.healthPath.trim() || '/healthz'
      let authHeader = form.authHeader.trim() || 'authorization'
      let credential = form.credential
      if (form.protocol === 'mcp') {
        const mcp = parseMcpConfig(form.mcpConfig)
        baseUrl = mcp.baseUrl
        healthPath = mcp.healthPath
        authHeader = mcp.header
        credential = mcp.credential ?? ''
      }
      if (!baseUrl) throw new Error('baseUrl 必填')

      const saved = await saveMutation.mutateAsync({
        service: form.service.trim(),
        title: form.title.trim(),
        owner: form.owner.trim(),
        protocol: form.protocol,
        baseUrl,
        healthPath,
        allowHttp: baseUrl.startsWith('http://'),
        auth: {
          mode: 'gateway-injected',
          header: authHeader,
          ...(credential ? { credential } : {}),
        },
        capabilities: form.capabilities,
      })
      const check = saved.selfCheck
      if (check && !(check.connected && check.smoke)) {
        // 两项自检没过：登记已落库但留在 draft，页面把原因说清楚
        toastError(`已登记为草稿：${check.message ?? '自检未通过'}`)
      } else {
        toastSuccess(check ? '已登记并启用（连通 + 冒烟通过）' : '已登记到网关')
      }
      setFormOpen(false)
      await listQuery.refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const services = listQuery.data ?? []
  const mcpServices = services.filter((service) => service.protocol === 'mcp')
  const internalServices = services.filter((service) => service.source === 'code')
  const externalServices = services.filter(
    (service) => service.source === 'manual' && service.protocol !== 'mcp',
  )
  const visibleServices =
    serviceFilter === 'all'
      ? services
      : serviceFilter === 'mcp'
        ? mcpServices
        : serviceFilter === 'internal'
          ? internalServices
          : externalServices
  const current = inspecting
    ? (inspecting.capabilities.find((item) => item.tool === inspectTool) ??
      inspecting.capabilities[0])
    : null
  const serviceToolKeys = new Set(
    services.flatMap((service) => service.capabilities.map((capability) => capability.tool)),
  )
  /** 运行时编排工具（plan / 子助手 / 技能库）：不在能力目录里，但同样有工具级配置 */
  const runtimeTools = (aiToolsQuery.data?.items ?? []).filter(
    (tool) => !serviceToolKeys.has(tool.toolKey),
  )
  const currentParams = current ? schemaParams(current.inputSchema) : null
  const currentTool = current
    ? (aiToolsQuery.data?.items ?? []).find((tool) => tool.toolKey === current.tool)
    : undefined

  const saveTool = async (dto: AiToolUpdateDto) => {
    await updateToolMutation.mutateAsync(dto)
    await aiToolsQuery.refetch()
    toastSuccess('工具配置已更新（下次调用生效）')
  }
  const resetTool = async (tool: AiToolModel) => {
    await resetToolMutation.mutateAsync({ toolKey: tool.toolKey })
    await aiToolsQuery.refetch()
    toastSuccess('已恢复代码默认值')
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:py-6">
      <PageToolbar
        title="能力服务"
        description="内部服务的实例进程自登记（进程 = 一个服务）；外部服务在这里登记地址、鉴权与能力清单。网关是唯一写方，页面只读 + 转发。"
        extra={
          <>
            {runtimeTools.length > 0 ? (
              <Button variant="outline" onClick={() => setRuntimeToolsOpen(true)}>
                <WrenchIcon className="mr-1 size-4" /> 运行时工具（{runtimeTools.length}）
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void listQuery.refetch()}>
              <RotateCwIcon className="mr-1 size-4" /> 刷新
            </Button>
            <Button onClick={openCreate}>
              <PlusIcon className="mr-1 size-4" /> 登记外部服务
            </Button>
          </>
        }
      />

      {services.length === 0 ? (
        <div className="rounded-xl bg-card p-8 text-center">
          <p className="text-sm">还没有登记任何服务</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {listQuery.isLoading
              ? '加载中…'
              : '内部服务启动并连上网关后会自动出现；外部服务点右上角「登记外部服务」。'}
          </p>
        </div>
      ) : (
        <>
          <SegmentedControl
            value={serviceFilter}
            options={[
              { label: `全部（${services.length}）`, value: 'all' },
              { label: `MCP（${mcpServices.length}）`, value: 'mcp' },
              { label: `内部（${internalServices.length}）`, value: 'internal' },
              { label: `外部（${externalServices.length}）`, value: 'external' },
            ]}
            onValueChange={(next) =>
              setServiceFilter(next as 'all' | 'mcp' | 'internal' | 'external')
            }
          />
          {visibleServices.length === 0 ? (
            <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground">
              这个筛选下没有服务
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {visibleServices.map((service) => {
                const isInternal = service.source === 'code'
                return (
                  <article key={service.service} className="rounded-xl bg-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{service.title}</span>
                          <code className="font-mono text-[11px] text-muted-foreground">
                            {service.service}
                          </code>
                          {statusTag(service)}
                          {protocolTag(service)}
                          {/* MCP 不走 HTTP 探活（GET /mcp 会 405），不展示探活状态 */}
                          {isInternal || service.protocol === 'mcp' ? null : probeTag(service)}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {service.baseUrl ?? '（由实例注册）'} · {service.owner} ·{' '}
                          {service.capabilities.length} 个能力 · v{service.version}
                          {service.hasCredential ? ' · 已配凭据' : ''}
                        </div>
                      </div>
                      {isInternal && service.service !== 'gateway' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {service.status === 'active' ? '启用' : '停用'}
                          </span>
                          <Switch
                            checked={service.status === 'active'}
                            disabled={statusMutation.isPending}
                            onCheckedChange={(enabled) => void toggleStatus(service, enabled)}
                          />
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => openInspect(service)}>
                        能力清单（{service.capabilities.length}）
                      </Button>
                      {isInternal ? null : (
                        <>
                          <Button size="sm" variant="outline" onClick={() => openEdit(service)}>
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void testService(service)}
                          >
                            测试连通
                          </Button>
                          <ConfirmAction
                            danger
                            title={`删除服务 ${service.service}？`}
                            description="删除后能力从目录消失，已引用这些能力的会话将无法再调用。"
                            onConfirm={() => removeService(service.service)}
                          >
                            删除
                          </ConfirmAction>
                        </>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* 能力清单：居中弹窗 + 左右主从（左选能力，右看描述与参数说明） */}
      <Dialog
        open={inspecting !== null}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
      >
        <DialogContent className="h-[80dvh] sm:max-w-[50vw]" bodyScroll={false}>
          <DialogHeader>
            <DialogTitle>能力清单 · {inspecting?.title ?? ''}</DialogTitle>
            <DialogDescription>
              {inspecting?.service ?? ''} · 共 {inspecting?.capabilities.length ?? 0} 个能力；
              参数说明来自登记时的 inputSchema
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1">
            <div className="w-60 shrink-0 overflow-y-auto bg-surface-1 p-2">
              {(inspecting?.capabilities ?? []).map((capability) => {
                const active = capability.tool === current?.tool
                return (
                  <button
                    key={capability.tool}
                    type="button"
                    onClick={() => setInspectTool(capability.tool)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                      active
                        ? 'bg-brand/12 text-brand'
                        : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                    )}
                  >
                    <span className="w-full truncate text-xs font-medium">{capability.title}</span>
                    <span className="w-full truncate font-mono text-[11px] opacity-80">
                      {capability.tool}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {current ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{current.title}</span>
                    <Tag color={current.risk === 'write' ? 'warning' : 'default'}>
                      {current.risk === 'write' ? '写' : '读'}
                    </Tag>
                    <code className="font-mono text-[11px] text-muted-foreground">
                      {current.tool}
                    </code>
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">{current.description}</p>

                  <div className="mt-4 text-sm font-medium">参数说明</div>
                  {currentParams === null ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      入参不是对象 schema（没有 properties），按 JSON 原样展示：
                      <JsonView value={current.inputSchema} maxHeight={240} className="mt-2" />
                    </div>
                  ) : currentParams.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">这个能力没有参数。</p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-2">
                      {currentParams.map((param) => (
                        <li key={param.name} className="rounded-lg bg-surface-1 p-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="font-mono text-xs">{param.name}</code>
                            <span className="text-[11px] text-muted-foreground">{param.type}</span>
                            {param.required ? <Tag color="warning">必填</Tag> : <Tag>可选</Tag>}
                            {param.defaultValue === undefined ? null : (
                              <span className="text-[11px] text-muted-foreground">
                                默认 {param.defaultValue}
                              </span>
                            )}
                          </div>
                          {param.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {param.description}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-6 border-t border-border/60 pt-4">
                    <div className="text-sm font-medium">工具配置</div>
                    {currentTool ? (
                      <>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Tag color={currentTool.enabled ? 'success' : 'default'}>
                            {currentTool.enabled ? '已启用' : '已停用'}
                          </Tag>
                          <span>作用域 {currentTool.scope}</span>
                          <span>类别 {currentTool.category}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-3"
                          onClick={() => {
                            setToolEditing(currentTool)
                            setToolFormOpen(true)
                          }}
                        >
                          编辑工具配置
                        </Button>
                      </>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {inspecting?.source === 'manual'
                          ? '外部 / MCP 能力没有工具级配置行：使用服务级凭据与「服务授权」。'
                          : '这个能力没有工具级配置行（例如网关内建能力）。'}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">这个服务还没有能力。</p>
              )}
            </div>
          </div>
          {/* 固定高度 + bodyScroll={false}：页脚用普通流式布局，别用默认的 sticky（会停在弹窗中部盖住列表） */}
          <DialogFooter className="static shrink-0">
            <Button variant="outline" onClick={() => setInspecting(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToolFormModal
        tool={toolEditing}
        workspaceStatus={workspaceQuery.data}
        open={toolFormOpen}
        onSave={saveTool}
        onReset={resetTool}
        saving={updateToolMutation.isPending || resetToolMutation.isPending}
        onClose={() => setToolFormOpen(false)}
      />

      <Dialog
        open={runtimeToolsOpen}
        onOpenChange={(open) => (!open ? setRuntimeToolsOpen(false) : undefined)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>运行时工具（{runtimeTools.length}）</DialogTitle>
            <DialogDescription>
              由 runtime 本地执行、不在能力目录里的工具；点「编辑」配置开关、限额与专属配置。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[55dvh] flex-col gap-1 overflow-y-auto px-2">
            {runtimeTools.map((tool) => (
              <div
                key={tool.toolKey}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-surface-1"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{tool.title}</span>
                    <code className="font-mono text-[11px] text-muted-foreground">
                      {tool.toolKey}
                    </code>
                    <Tag color={tool.enabled ? 'success' : 'default'}>
                      {tool.enabled ? '已启用' : '已停用'}
                    </Tag>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRuntimeToolsOpen(false)
                    setToolEditing(tool)
                    setToolFormOpen(true)
                  }}
                >
                  编辑
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRuntimeToolsOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 登记 / 编辑：按协议联动 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.service}` : '登记外部服务'}</DialogTitle>
            <DialogDescription>
              {form.protocol === 'mcp'
                ? 'MCP 服务按标准配置登记；保存时网关会做 initialize 握手，并可以同步工具清单。'
                : '对方实现 POST /invoke（约 30 行）即可；这里的凭据是网关调对方时带的 header。'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label>原生协议</Label>
              <SegmentedControl
                value={form.protocol}
                options={[
                  { label: '能力协议', value: 'capability' },
                  { label: 'MCP', value: 'mcp' },
                ]}
                onValueChange={(value) =>
                  // 换协议就清空能力清单：能力是对方服务的事实，不能跨协议沿用
                  setForm({
                    ...form,
                    protocol: value as CapabilityServiceProtocol,
                    capabilities: [],
                  })
                }
              />
            </div>

            <div className="grid gap-1.5">
              <Label>服务名（全局唯一）</Label>
              <Input
                value={form.service}
                disabled={Boolean(editing)}
                placeholder="order"
                onChange={(event) => setForm({ ...form, service: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>标题</Label>
              <Input
                value={form.title}
                placeholder="订单服务"
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>负责人</Label>
              <Input
                value={form.owner}
                placeholder="B 团队"
                onChange={(event) => setForm({ ...form, owner: event.target.value })}
              />
            </div>

            {form.protocol === 'capability' ? (
              <>
                <div className="grid gap-1.5">
                  <Label>baseUrl</Label>
                  <Input
                    value={form.baseUrl}
                    placeholder="https://orders.example.com"
                    onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>健康检查路径</Label>
                  <Input
                    value={form.healthPath}
                    onChange={(event) => setForm({ ...form, healthPath: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>鉴权 header</Label>
                  <Input
                    value={form.authHeader}
                    onChange={(event) => setForm({ ...form, authHeader: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>凭据（留空 = 不改）</Label>
                  <Input
                    type="password"
                    value={form.credential}
                    onChange={(event) => setForm({ ...form, credential: event.target.value })}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label>MCP 配置（JSON）</Label>
                <Textarea
                  className="min-h-40 font-mono text-xs"
                  value={form.mcpConfig}
                  onChange={(event) => setForm({ ...form, mcpConfig: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  填 <code className="font-mono">{'{ "url": "…", "headers": { … } }'}</code>
                  ；也兼容 <code className="font-mono">mcpServers</code> 包裹（取第一个服务）。
                  stdio 型需要本地适配器，暂不支持；保存时会从配置派生 baseUrl / header / 凭据。
                </p>
              </div>
            )}

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>能力清单（{form.capabilities.length}）</Label>
                <span className="text-xs text-muted-foreground">只能同步，不能手填</span>
              </div>
              {form.capabilities.length === 0 ? (
                <p className="rounded-lg bg-surface-1 p-3 text-xs text-muted-foreground">
                  {form.protocol === 'mcp'
                    ? '还没有能力：点下面的「同步能力清单」，网关会对 MCP server 做 initialize + tools/list。'
                    : '还没有能力：点下面的「同步能力清单」从对方 /manifest 拉取，保存前必须至少有一条。'}
                </p>
              ) : (
                <ul className="max-h-48 overflow-y-auto rounded-lg bg-surface-1 p-2">
                  {form.capabilities.map((capability) => (
                    <li key={capability.tool} className="flex items-center gap-2 px-1 py-1">
                      <code className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {capability.tool}
                      </code>
                      <span className="min-w-0 flex-1 truncate text-xs">{capability.title}</span>
                      <Tag color={capability.risk === 'write' ? 'warning' : 'default'}>
                        {capability.risk === 'write' ? '写' : '读'}
                      </Tag>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testMutation.isPending}
                  onClick={() => void testConnection()}
                >
                  测试连通
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pullMutation.isPending || pullMcpMutation.isPending}
                  onClick={() => void syncCapabilities()}
                >
                  同步能力清单
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button disabled={saveMutation.isPending} onClick={() => void submit()}>
              保存并登记
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
