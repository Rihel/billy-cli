'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { AdminModel, CapabilityServiceModel } from '@repo/shared'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  PageToolbar,
  Tag,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { RotateCwIcon, ShieldCheckIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

/**
 * 服务授权（`/main/ai/authorizations`）。
 *
 * 口径：自建协议服务（`source='code'`，如 common）默认全部可用，不参与授权；
 * 只有外部服务 / MCP（`source='manual'`）需要按管理员勾选。任何管理员都能改。
 */
export default function AuthorizationsPage() {
  const client = useServerClient()
  const [editing, setEditing] = useState<AdminModel | null>(null)
  const [selected, setSelected] = useState<string[]>([])

  const adminsQuery = useQuery({
    queryKey: ['admin', 'all-for-grants'],
    queryFn: () =>
      client.admin.pageQuery({ page: 1, size: 100, orderBy: 'createdAt', order: 'asc' }),
  })
  const servicesQuery = useQuery({
    queryKey: ['capabilityService', 'list'],
    queryFn: () => client.capabilityService.list({}),
  })
  const grantsQuery = useQuery({
    queryKey: ['capabilityService', 'grants'],
    queryFn: () => client.capabilityService.listGrants(),
  })
  const saveMutation = useMutation({
    mutationFn: (input: { adminId: string; services: string[] }) =>
      client.capabilityService.setGrants(input),
  })

  const services: CapabilityServiceModel[] = servicesQuery.data ?? []
  const manual = services.filter((service) => service.source === 'manual')
  const code = services.filter((service) => service.source === 'code')
  const admins: AdminModel[] = adminsQuery.data?.items ?? []

  const grantedByAdmin = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const grant of grantsQuery.data ?? []) {
      const list = map.get(grant.principalId) ?? []
      list.push(grant.service)
      map.set(grant.principalId, list)
    }
    return map
  }, [grantsQuery.data])

  const openEdit = (admin: AdminModel) => {
    setEditing(admin)
    setSelected(grantedByAdmin.get(admin.id) ?? [])
  }

  const refresh = async () => {
    await Promise.all([adminsQuery.refetch(), servicesQuery.refetch(), grantsQuery.refetch()])
  }

  const toggle = (service: string, checked: boolean) => {
    setSelected((current) =>
      checked ? [...new Set([...current, service])] : current.filter((item) => item !== service),
    )
  }

  const save = async () => {
    if (!editing) return
    try {
      await saveMutation.mutateAsync({ adminId: editing.id, services: selected })
      await grantsQuery.refetch()
      setEditing(null)
      toastSuccess('授权已更新（网关 5 秒内生效）')
    } catch (error) {
      toastError(error instanceof Error ? error.message : '保存失败')
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:py-6">
      <PageToolbar
        title="服务授权"
        description="外部服务 / MCP 需要按管理员授权；自建协议服务（如 common）默认全部可用，不参与授权。任何管理员都能修改。"
        extra={
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={adminsQuery.isFetching}
          >
            <RotateCwIcon className="mr-1 size-4" /> 刷新
          </Button>
        }
      />

      <div className="rounded-xl border border-border/70 bg-surface-1/40 p-4 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheckIcon className="mr-1 inline size-4" />
        自建协议服务（{code.length > 0 ? code.map((item) => item.service).join('、') : '暂无'}）
        对全部管理员可用；下面的勾选只影响外部服务 / MCP。
      </div>

      <div className="flex flex-col gap-3">
        {admins.map((admin) => {
          const granted = grantedByAdmin.get(admin.id) ?? []
          return (
            <article
              key={admin.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{admin.realName || admin.email}</span>
                  <span className="text-xs text-muted-foreground">{admin.email}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {granted.length === 0 ? (
                    <span className="text-xs text-muted-foreground">未授权任何外部服务</span>
                  ) : (
                    granted.map((service) => (
                      <Tag key={service} color="default">
                        {service}
                      </Tag>
                    ))
                  )}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => openEdit(admin)}>
                编辑授权
              </Button>
            </article>
          )
        })}
        {admins.length === 0 ? (
          <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground">
            {adminsQuery.isLoading ? '加载中…' : '还没有管理员'}
          </div>
        ) : null}
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => (!open ? setEditing(null) : undefined)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑授权 · {editing?.realName || editing?.email}</DialogTitle>
            <DialogDescription>
              勾选该管理员可用的外部服务 / MCP；保存后覆盖原有授权。
            </DialogDescription>
          </DialogHeader>

          {manual.length === 0 ? (
            <p className="px-4 text-sm text-muted-foreground">
              还没有外部服务 / MCP：先到「能力服务」登记，再回来授权。
            </p>
          ) : (
            <div className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto px-2">
              {manual.map((service) => (
                <Label
                  key={service.service}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-surface-1"
                >
                  <Checkbox
                    checked={selected.includes(service.service)}
                    onCheckedChange={(checked) => toggle(service.service, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm">
                      {service.title}
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {service.service}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {service.protocol === 'mcp' ? 'MCP' : '能力协议'} ·{' '}
                      {service.capabilities.length} 个工具
                    </span>
                  </span>
                </Label>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              onClick={() => void save()}
              disabled={saveMutation.isPending || manual.length === 0}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
