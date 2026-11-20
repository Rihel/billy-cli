'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tag,
  toastError,
} from '@repo/ui'
import { SearchIcon } from 'lucide-react'
import { grantStateOf, splitDesired } from '@/lib/batch-grant'
import type { GrantState } from '@/lib/batch-grant'

/**
 * 批量授权弹窗（技能库 / 能力服务共用）。
 *
 * 口径：
 * 1. 页面里勾选若干条目 → 打开本弹窗 → 勾选主体（用户 / 管理员）；
 * 2. **勾选 = 授予，取消勾选 = 收回，没动过的主体保持原样** —— 弹窗只提交差量，
 *    不会把别人先前的授权覆盖掉（技能授权接口本身是覆盖式的，差量由调用方合并后写入）；
 * 3. 主体在「已选条目」上的状态有三态：全部已授（勾选）/ 部分已授（半选）/ 未授（不勾）；
 *    半选点一下 = 全部授予，已勾点一下 = 全部收回；
 * 4. 已授权但不在搜索结果里的主体，搜出来取消勾选即可收回。
 */

/** 可授权的主体（用户 / 管理员） */
export interface GrantCandidate {
  /** 主体 id */
  id: string
  /** 主标题（姓名 / 邮箱） */
  label: string
  /** 次标题（邮箱 / 状态） */
  hint?: string
}

/** 被授权的条目（技能 / 服务） */
export interface GrantItem {
  id: string
  label: string
}

export interface BatchGrantApplyInput {
  /** 要确保授予的主体 id */
  add: string[]
  /** 要收回的主体 id */
  remove: string[]
}

export interface BatchGrantDialogProps {
  open: boolean
  onClose: () => void
  /** 页面里勾选的条目；只用于展示与计算差量 */
  items: GrantItem[]
  /** 主体称呼（用户 / 管理员） */
  principalLabel: string
  /** 缓存命名空间，避免两个页面共用同名 key */
  scopeKey: string
  /** 顶部补充说明（例如「只对平台技能生效」） */
  notice?: ReactNode
  /** 按关键字搜主体（空关键字给第一批） */
  searchPrincipals: (keyword: string) => Promise<GrantCandidate[]>
  /** 条目 id → 当前已授权的主体 id 集合（每个条目都要有键） */
  loadGrants: (itemIds: string[]) => Promise<Map<string, Set<string>>>
  /** 提交差量：调用方负责合并成覆盖式写入 */
  onApply: (input: BatchGrantApplyInput) => Promise<void>
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 条目摘要：最多列 3 个名字，其余收成「等 N 项」 */
const summarize = (items: GrantItem[]): string => {
  const names = items
    .slice(0, 3)
    .map((item) => item.label)
    .join('、')
  return items.length > 3 ? `${names} 等 ${items.length} 项` : names
}

export function BatchGrantDialog({
  open,
  onClose,
  items,
  principalLabel,
  scopeKey,
  notice,
  searchPrincipals,
  loadGrants,
  onApply,
}: BatchGrantDialogProps) {
  const itemIds = items.map((item) => item.id)
  const itemsKey = itemIds.join('|')
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  /** 用户动过的主体：'all' = 要授予，'none' = 要收回；没动过的不在表里 */
  const [desired, setDesired] = useState<Map<string, 'all' | 'none'>>(new Map())
  const [applying, setApplying] = useState(false)

  // 每次打开都从干净状态开始：搜索词、差量、当前授权都重新取
  useEffect(() => {
    if (!open) return
    setKeyword('')
    setDebounced('')
    setDesired(new Map())
  }, [open])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim()), 250)
    return () => clearTimeout(timer)
  }, [keyword])

  const grantsQuery = useQuery({
    queryKey: ['batch-grant', scopeKey, 'grants', itemsKey],
    queryFn: () => loadGrants(items.map((item) => item.id)),
    enabled: open && items.length > 0,
    refetchOnWindowFocus: false,
  })
  const searchQuery = useQuery({
    queryKey: ['batch-grant', scopeKey, 'principals', debounced],
    queryFn: () => searchPrincipals(debounced),
    enabled: open,
    refetchOnWindowFocus: false,
  })

  const granted = grantsQuery.data
  const candidates = searchQuery.data ?? []

  const stateOf = (principalId: string): GrantState =>
    desired.get(principalId) ?? grantStateOf(granted, itemIds, principalId)

  const toggle = (principalId: string, checked: boolean): void => {
    setDesired((current) => {
      const next = new Map(current)
      next.set(principalId, checked ? 'all' : 'none')
      return next
    })
  }

  const { add, remove } = splitDesired(desired)
  const dirty = add.length > 0 || remove.length > 0

  const apply = async (): Promise<void> => {
    if (!dirty || applying) return
    setApplying(true)
    try {
      await onApply({ add, remove })
      onClose()
    } catch (error) {
      toastError(messageOf(error))
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent bodyScroll={false} className="h-[68dvh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>授权 · 已选 {items.length} 项</DialogTitle>
          <DialogDescription>
            勾选{principalLabel} = 授予所选条目；取消勾选 = 收回；没动过的保持原样。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 px-4">
          <p className="truncate text-xs text-muted-foreground">已选条目：{summarize(items)}</p>
          <div className="flex items-center gap-1 rounded-lg bg-surface-1 px-2">
            <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={`搜索${principalLabel}姓名 / 邮箱…`}
              className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
            />
          </div>
          {notice ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{notice}</p>
          ) : null}
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {grantsQuery.isError ? (
            <p className="px-2 py-1 text-xs text-destructive">
              读取当前授权失败：{messageOf(grantsQuery.error)}
            </p>
          ) : null}
          {grantsQuery.isLoading ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">读取当前授权…</p>
          ) : null}
          {searchQuery.isLoading && candidates.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">搜索中…</p>
          ) : candidates.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {searchQuery.isError
                ? `搜索失败：${messageOf(searchQuery.error)}`
                : `没有匹配的${principalLabel}：换关键字或输入完整邮箱再搜`}
            </p>
          ) : (
            candidates.map((candidate) => {
              const state = stateOf(candidate.id)
              return (
                <Label
                  key={candidate.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-surface-1"
                >
                  <Checkbox
                    checked={state === 'all'}
                    indeterminate={state === 'some'}
                    disabled={grantsQuery.isLoading || applying}
                    onCheckedChange={(checked) => toggle(candidate.id, checked)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-normal">{candidate.label}</span>
                    {candidate.hint ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.hint}
                      </span>
                    ) : null}
                  </span>
                  {state === 'some' ? (
                    <Tag color="warning">部分授权</Tag>
                  ) : state === 'all' ? (
                    <Tag color="success">已授权</Tag>
                  ) : null}
                </Label>
              )
            })
          )}
        </div>

        <DialogFooter className="static shrink-0">
          <span className="mr-auto text-xs text-muted-foreground">
            {dirty
              ? `将授予 ${add.length} 个${principalLabel}、收回 ${remove.length} 个；保存后生效`
              : `还没有改动：勾选${principalLabel}即可授权`}
          </span>
          <Button variant="outline" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button onClick={() => void apply()} disabled={!dirty || applying}>
            {applying ? '保存中…' : '保存授权'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
