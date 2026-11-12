'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import dayjs from 'dayjs'
import { CopyIcon, LinkIcon, Trash2Icon } from 'lucide-react'
import { Button, DateTimePicker, Input, ModalForm, toastError, toastSuccess } from '@repo/ui'
import type { ShareItemModel, ShareState } from '@repo/shared'
import { useServerClient } from '@/lib/server-client'
import { copyText } from '@/lib/clipboard'

/**
 * 文件分享弹窗（设计 `docs/design/file-share.md` §6.5）。
 *
 * 三个交互要点：
 * - 选有效期 → 生成链接，**明文只在生成后显示一次**（库里只存哈希），关闭即不可再见；
 * - 历史分享只有状态 / 有效期 / 被看次数，不显示 token —— 要重发就再生成一条；
 * - 撤销立即生效，页面会刷新历史列表。
 */

type ShareForm = { expiresAt: string }

const STATE_TEXT: Record<ShareState, string> = {
  active: '有效',
  expired: '已过期',
  revoked: '已撤销',
  invalid: '无效',
}

export type ShareDialogFile = {
  id: string
  filename: string
}

const formatTime = (value: number | null | undefined, fallback = '—'): string =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm') : fallback

const expiryText = (item: ShareItemModel): string =>
  item.expiresAt ? `至 ${formatTime(item.expiresAt)}` : '永久'

export function ShareDialog({
  file,
  open,
  onClose,
}: {
  file: ShareDialogFile | null
  open: boolean
  onClose: () => void
}) {
  const client = useServerClient()
  const queryClient = useQueryClient()
  // 链接由**本应用的域名**拼：server 只回 token，不需要知道分享页挂在哪个域
  const [created, setCreated] = useState<{ url: string; expiresAt: number | null } | null>(null)

  const listQuery = useQuery({
    queryKey: ['share-list', file?.id],
    queryFn: () => client.share.list({ fileId: file!.id }),
    enabled: open && Boolean(file?.id),
  })

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: ['share-list', file?.id] })

  const createMutation = useMutation({
    mutationFn: (expiresAt: number) =>
      client.share.create({
        fileId: file!.id,
        expiresAt,
      }),
    onSuccess: (data) => {
      setCreated({
        url: `${window.location.origin}/s/${data.token}`,
        expiresAt: data.expiresAt,
      })
      toastSuccess('分享链接已生成')
      void invalidateList()
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => client.share.revoke({ id }),
    onSuccess: () => {
      toastSuccess('已撤销')
      void invalidateList()
    },
    onError: (error) => {
      toastError(error instanceof Error ? error.message : String(error))
    },
  })

  const form = useForm({
    defaultValues: { expiresAt: '' } as ShareForm,
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync(new Date(value.expiresAt).getTime())
    },
  })

  const copy = async () => {
    if (!created) return
    try {
      await copyText(created.url)
      toastSuccess('链接已复制')
    } catch (error) {
      toastError(error instanceof Error ? error.message : '复制失败')
    }
  }

  const close = () => {
    setCreated(null)
    onClose()
  }

  const items = listQuery.data?.items ?? []

  return (
    <ModalForm<ShareForm>
      open={open}
      title={`分享文件${file ? `：${file.filename}` : ''}`}
      form={form}
      // 每次打开都按「此刻 + 7 天」预填，而不是组件挂载时算死的那个值
      values={{ expiresAt: dayjs().add(7, 'day').format('YYYY-MM-DDTHH:mm') }}
      items={[
        {
          name: 'expiresAt',
          label: '过期时间',
          required: true,
          hint: '到点后链接自动失效；也可以随时在下方历史里手动撤销',
          render: ({ field }) => (
            <DateTimePicker
              value={String(field.state.value ?? '')}
              onChange={(next) => field.handleChange(next)}
              min={new Date()}
            />
          ),
          validate: (value) => {
            const picked = new Date(String(value ?? '')).getTime()
            if (!Number.isFinite(picked)) return '请选择过期时间'
            if (picked <= Date.now()) return '过期时间必须晚于当前时间'
            return undefined
          },
        },
      ]}
      submitText="生成链接"
      loading={createMutation.isPending}
      onCancel={close}
      onError={(error) => {
        toastError(error instanceof Error ? error.message : String(error))
      }}
      description={
        <div className="flex flex-col gap-4">
          <p className="text-xs">
            免授权链接，<span className="text-foreground">任何人拿到都能直接打开</span>；
            外部访问者看不到系统信息与存储地址。
          </p>

          {created ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-3">
              <div className="flex items-center gap-2 text-xs text-foreground">
                <LinkIcon className="size-3.5" />
                链接已生成，<span className="font-medium">关闭后不再显示</span>
              </div>
              <div className="flex items-center gap-2">
                <Input readOnly value={created.url} className="h-8 font-mono text-xs" />
                <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
                  <CopyIcon className="size-3.5" />
                  复制
                </Button>
              </div>
              <div className="text-[11px]">有效期：{created.expiresAt ? formatTime(created.expiresAt) : '永久'}</div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-foreground">历史分享</div>
            {items.length === 0 ? (
              <div className="text-xs">{listQuery.isLoading ? '加载中…' : '还没有分享记录'}</div>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-xs text-foreground">
                        {STATE_TEXT[item.state]} · {expiryText(item)}
                      </span>
                      <span className="text-[11px]">
                        被查看 {item.views} 次 · 创建于 {formatTime(item.createdAt)}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      title="撤销该分享"
                      disabled={item.state !== 'active' || revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(item.id)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      }
    />
  )
}
