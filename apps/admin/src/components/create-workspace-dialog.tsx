'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { useServerClient } from '@/lib/server-client'

export interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功后的回调（调用方负责失效对应的列表查询） */
  onCreated: () => void | Promise<void>
}

/**
 * **新建工作区**弹窗（工作区页与会话页共用）。
 *
 * 用户不关心代码存在哪，也不该填路径：这里只让用户起个名字，下面一行如实告诉他
 * 「会保存在哪」（容器内 / 本机自动分配的目录）。后端与驱动由部署配置决定
 * （`WORKSPACE_DEFAULT_BACKEND` / `WORKSPACE_DEFAULT_DRIVER`），要换单个工作区用卡片上的「驱动」。
 */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceDialogProps) {
  const client = useServerClient()
  const [name, setName] = useState('')

  const { data: defaults } = useQuery({
    queryKey: ['workspace-defaults'],
    queryFn: () => client.workspace.defaults(),
    staleTime: 60_000,
  })

  const create = useMutation({
    mutationFn: () => client.workspace.create({ name: name.trim() || undefined }),
    onSuccess: async () => {
      toastSuccess('工作区已创建')
      setName('')
      onOpenChange(false)
      await onCreated()
    },
    onError: (error) => {
      toastError(error instanceof Error ? error.message : String(error))
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建工作区</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-name">名称</Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：数据分析"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            会保存在：{defaults?.location ?? '创建时自动分配'}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
