'use client'

import { useEffect, useState } from 'react'
import { AiMemoryKind, MEMORY_CONTENT_MAX } from '@repo/shared'
import type { AiMemoryModel, AiMemoryUpdateDto } from '@repo/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DictSelect,
  Label,
  Switch,
  Textarea,
} from '@repo/ui'

/** 编辑一条记忆：内容 / 类型 / 置顶 / 启用（归属与 key 不可改） */
export interface MemoryEditDialogProps {
  /** 为 null 时关闭 */
  memory: AiMemoryModel | null
  saving: boolean
  onClose: () => void
  onSave: (input: AiMemoryUpdateDto) => Promise<void>
}

export function MemoryEditDialog({ memory, saving, onClose, onSave }: MemoryEditDialogProps) {
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (!memory) return
    setContent(memory.content)
    setKind(memory.kind)
    setPinned(memory.pinned)
    setEnabled(memory.enabled)
  }, [memory])

  const submit = async (): Promise<void> => {
    if (!memory || saving) return
    const trimmed = content.trim()
    if (!trimmed) return
    await onSave({
      id: memory.id,
      content: trimmed,
      ...(kind ? { kind: kind as AiMemoryUpdateDto['kind'] } : {}),
      pinned,
      enabled,
    })
  }

  return (
    <Dialog open={Boolean(memory)} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑记忆</DialogTitle>
          <DialogDescription>
            这段内容会在每轮对话里作为「用户历史信息」注入（不是指令）；改完下一轮生效。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="memory-content" className="text-xs">
              内容（最多 {MEMORY_CONTENT_MAX} 字符）
            </Label>
            <Textarea
              id="memory-content"
              value={content}
              maxLength={MEMORY_CONTENT_MAX}
              rows={4}
              className="text-sm"
              onChange={(event) => setContent(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              当前 {Array.from(content).length} / {MEMORY_CONTENT_MAX}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Label className="text-xs">类型</Label>
            <DictSelect
              dict={AiMemoryKind}
              value={kind}
              placeholder="选择类型"
              onValueChange={(next) => setKind(next)}
            />
          </div>

          <div className="flex items-center gap-6">
            <Label className="gap-2 text-xs">
              <Switch checked={pinned} onCheckedChange={(next) => setPinned(next === true)} />
              置顶（每轮优先带）
            </Label>
            <Label className="gap-2 text-xs">
              <Switch checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
              启用
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            disabled={saving || content.trim().length === 0}
            onClick={() => void submit()}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
