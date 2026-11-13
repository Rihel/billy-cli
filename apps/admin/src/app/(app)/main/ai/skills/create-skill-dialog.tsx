'use client'

/* oxlint-disable jsx-a11y/no-autofocus -- 弹窗打开 / 进入编辑即聚焦首个输入框，键盘用户可直接输入 */

import { useEffect, useState } from 'react'
import { SKILL_KEY_PATTERN } from '@repo/shared'
import type { AiSkillCreateDto } from '@repo/shared'
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
} from '@repo/ui'

/**
 * 新建技能：**只填一个名字**，回车直接进编辑器。
 *
 * description 先落占位（Mastra 不允许空描述），在编辑器里补 —— 这样"新建"不再是一张
 * 六七行的表单，而是一步进入写作。
 */
export interface CreateSkillDialogProps {
  open: boolean
  saving: boolean
  onClose: () => void
  onCreate: (dto: AiSkillCreateDto) => Promise<void>
}

export function CreateSkillDialog({ open, saving, onClose, onCreate }: CreateSkillDialogProps) {
  const [skillKey, setSkillKey] = useState('')

  useEffect(() => {
    if (open) setSkillKey('')
  }, [open])

  const valid = SKILL_KEY_PATTERN.test(skillKey.trim())

  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    await onCreate({ skillKey: skillKey.trim(), body: '', enabled: true })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建技能</DialogTitle>
          <DialogDescription>
            先起一个名字，建好直接进编辑器；技能名就是目录名，创建后不能改。
          </DialogDescription>
        </DialogHeader>

        {/* 包一层：DialogContent 会把**直接子元素**套上 px-4（那是内边距，不是外边距），
            直接放 Input 会让输入框的边框贴到弹窗边上 */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-skill-key" className="text-xs">
            技能名
          </Label>
          {/* 打开弹窗即聚焦主输入框：键盘优先，属有意的交互 */}
          <Input
            autoFocus
            id="new-skill-key"
            value={skillKey}
            placeholder="例如 code-review"
            className="h-11 text-base"
            onChange={(event) => setSkillKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
          <p className="text-xs text-muted-foreground">
            小写字母 / 数字 / 连字符，以字母或数字开头，≤64 字符；回车直接创建
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? '创建中…' : '创建并打开编辑器'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
