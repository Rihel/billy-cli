'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CapabilityServiceModel, CapabilityServiceSaveDto } from '@repo/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { PlusIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

/** 表单里能力清单用 JSON 编辑：先跑通，后面再做成逐条表单 */
const emptyForm = () => ({
  service: '',
  title: '',
  owner: '',
  baseUrl: '',
  healthPath: '/healthz',
  authHeader: 'x-api-key',
  credential: '',
  capabilities: '[]',
})

type FormState = ReturnType<typeof emptyForm>

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 能力服务（`/main/ai/capabilities`）—— 外部 API 的登记入口。
 *
 * 页面口径：
 * 1. 保存 = 到网关登记（`source:'manual'`），网关是唯一写方；
 * 2. 「测试连通」与「拉清单」都不落库，只给你看结果；
 * 3. 下线一个服务只改状态，不删记录（历史对话还引用着能力 key）。
 */
export default function CapabilitiesPage() {
  const client = useServerClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<CapabilityServiceModel | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())

  const listQuery = useQuery({
    queryKey: ['capabilityService', 'list'],
    queryFn: () => client.capabilityService.list({}),
  })

  const saveMutation = useMutation({
    mutationFn: (dto: CapabilityServiceSaveDto) => client.capabilityService.save(dto),
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

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setOpen(true)
  }

  const openEdit = (service: CapabilityServiceModel) => {
    setEditing(service)
    setForm({
      service: service.service,
      title: service.title,
      owner: service.owner,
      baseUrl: service.baseUrl ?? '',
      healthPath: service.healthPath,
      authHeader: 'x-api-key',
      credential: '',
      capabilities: JSON.stringify(
        service.capabilities.map((item) => ({
          tool: item.tool,
          title: item.title,
          description: item.description,
          risk: item.risk,
          inputSchema: { type: 'object' },
        })),
        null,
        2,
      ),
    })
    setOpen(true)
  }

  const submit = async () => {
    try {
      const capabilities = JSON.parse(form.capabilities) as unknown
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        throw new Error('能力清单至少一条')
      }
      await saveMutation.mutateAsync({
        service: form.service,
        title: form.title,
        owner: form.owner,
        baseUrl: form.baseUrl,
        healthPath: form.healthPath,
        allowHttp: form.baseUrl.startsWith('http://'),
        auth: {
          mode: 'gateway-injected',
          header: form.authHeader,
          ...(form.credential ? { credential: form.credential } : {}),
        },
        capabilities: capabilities as CapabilityServiceSaveDto['capabilities'],
      })
      toastSuccess('已登记到网关')
      setOpen(false)
      await listQuery.refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const services = listQuery.data ?? []

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">能力服务</h1>
          <p className="text-sm text-muted-foreground">
            外部 API 填一次地址、鉴权与能力清单即可被模型调用；登记写在网关，页面只读。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void listQuery.refetch()}>
            刷新
          </Button>
          <Button onClick={openCreate}>
            <PlusIcon className="mr-1 size-4" /> 登记服务
          </Button>
        </div>
      </div>

      {services.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
          {listQuery.isLoading ? '加载中…' : '还没有登记任何外部服务'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {services.map((service) => (
            <div key={service.service} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{service.title}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{service.service}</code>
                <span className="rounded border px-1.5 py-0.5 text-xs">{service.status}</span>
                <span className="text-xs text-muted-foreground">
                  {service.source} · {service.capabilities.length} 个能力 · v{service.version}
                  {service.hasCredential ? ' · 已配凭据' : ' · 无凭据'}
                  {service.probe ? ` · ${service.probe.state}` : ''}
                </span>
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {service.baseUrl ?? '（由实例注册）'} · owner {service.owner}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => openEdit(service)}>
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!service.baseUrl) return toastError('这个服务由实例注册，没有 baseUrl 可测')
                    try {
                      const result = await testMutation.mutateAsync({
                        baseUrl: service.baseUrl,
                        healthPath: service.healthPath,
                      })
                      if (result.ok) toastSuccess('连通正常')
                      else toastError(result.message ?? '连不上')
                    } catch (error) {
                      toastError(messageOf(error))
                    }
                  }}
                >
                  测试连通
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!service.baseUrl) return toastError('没有 baseUrl')
                    try {
                      const manifest = await pullMutation.mutateAsync({
                        baseUrl: service.baseUrl,
                        healthPath: service.healthPath,
                      })
                      setEditing(service)
                      setForm({
                        service: service.service,
                        title: service.title,
                        owner: service.owner,
                        baseUrl: service.baseUrl,
                        healthPath: service.healthPath,
                        authHeader: 'x-api-key',
                        credential: '',
                        capabilities: JSON.stringify(manifest, null, 2),
                      })
                      setOpen(true)
                      toastSuccess('已拉取清单，确认后保存')
                    } catch (error) {
                      toastError(messageOf(error))
                    }
                  }}
                >
                  拉清单
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await statusMutation.mutateAsync({
                        service: service.service,
                        status: service.status === 'active' ? 'disabled' : 'active',
                      })
                      await listQuery.refetch()
                    } catch (error) {
                      toastError(messageOf(error))
                    }
                  }}
                >
                  {service.status === 'active' ? '停用' : '启用'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (!window.confirm(`删除服务 ${service.service}？能力会从目录消失`)) return
                    try {
                      await removeMutation.mutateAsync(service.service)
                      await listQuery.refetch()
                    } catch (error) {
                      toastError(messageOf(error))
                    }
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 ${editing.service}` : '登记外部服务'}</DialogTitle>
            <DialogDescription>
              对方实现 `POST /invoke`（约 30 行）即可；这里的凭据是网关调对方时带的 header。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label>服务名（namespace，全局唯一）</Label>
              <Input
                value={form.service}
                disabled={Boolean(editing)}
                placeholder="order"
                onChange={(event) => setForm({ ...form, service: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>标题</Label>
              <Input
                value={form.title}
                placeholder="订单服务"
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>负责人</Label>
              <Input
                value={form.owner}
                placeholder="B 团队"
                onChange={(event) => setForm({ ...form, owner: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>baseUrl</Label>
              <Input
                value={form.baseUrl}
                placeholder="https://orders.example.com"
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>健康检查路径</Label>
              <Input
                value={form.healthPath}
                onChange={(event) => setForm({ ...form, healthPath: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>鉴权 header</Label>
              <Input
                value={form.authHeader}
                onChange={(event) => setForm({ ...form, authHeader: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>凭据（留空 = 不改）</Label>
              <Input
                type="password"
                value={form.credential}
                onChange={(event) => setForm({ ...form, credential: event.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label>能力清单（JSON 数组，至少一条）</Label>
              <Textarea
                className="min-h-40 font-mono text-xs"
                value={form.capabilities}
                onChange={(event) => setForm({ ...form, capabilities: event.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
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
