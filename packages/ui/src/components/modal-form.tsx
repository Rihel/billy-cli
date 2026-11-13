'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AnyFormApi } from '#components/form'

import { cn } from '#lib/utils'
import { Button } from '#components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog'
import { FormFields } from '#components/form'
import type { FormItem } from '#components/form'
import { Spinner } from '#components/ui/spinner'

/** 收集 items 中所有字段名（含分组与同排数组） */
const collectFieldNames = <Values extends object>(items?: Array<FormItem<Values>>): string[] => {
  const names: string[] = []
  for (const entry of items ?? []) {
    if (entry && typeof entry === 'object' && 'fields' in entry) {
      names.push(...collectFieldNames(entry.fields as Array<FormItem<Values>>))
    } else {
      const row = Array.isArray(entry) ? entry : [entry]
      for (const item of row) {
        if (item && typeof item.name === 'string') names.push(item.name)
      }
    }
  }
  return names
}

export type ModalFormProps<Values extends object> = {
  open: boolean
  title: ReactNode
  /** @tanstack/react-form 的 useForm 实例（onSubmit 在 useForm 中定义） */
  form: AnyFormApi<Values>
  children?: ReactNode
  items?: Array<FormItem<Values>>
  /** 打开弹窗时用于回填的值（如编辑记录）；变化时重新回填 */
  values?: Partial<Values>
  /** 字段区顶部的说明文案（随内容滚动；可传 Alert 等说明块） */
  description?: ReactNode
  /** 提交中状态（外部 mutation 进行中） */
  loading?: boolean
  /** 关闭时是否重置表单（默认 true） */
  resetOnClose?: boolean
  submitText?: string
  cancelText?: string
  /** 覆盖弹窗宽度等（高度与滚动由组件内置：头部/底部固定、内容区滚动） */
  dialogClassName?: string
  onCancel: () => void
  onError?: (error: unknown) => void
}

/**
 * 弹窗表单（Dialog + @tanstack/react-form）：声明式 items 或自定义 children。
 * 布局：头部（标题）固定顶部、底部（取消/提交）固定底部、中间内容区
 * （说明 + 字段）独立滚动；弹窗高度 max-h 内不会撑破视口。
 * 回填：传 values 时，弹窗打开（open 变 true 或 values 变化）会用
 * form.setFieldValue 逐字段写入（绕开 tanstack reset 的渲染同步问题）。
 */
export function ModalForm<Values extends object>({
  open,
  title,
  form,
  children,
  items,
  values,
  description,
  loading,
  resetOnClose = true,
  submitText = '提交',
  cancelText = '取消',
  dialogClassName,
  onCancel,
  onError,
}: ModalFormProps<Values>) {
  const [submitting, setSubmitting] = useState(false)
  /**
   * 表单 id：**底部提交按钮在 `<form>` 之外**（页脚要固定在底部、不随内容滚动），
   * 所以必须用 `form={formId}` 把按钮显式关联回表单 ——
   * 少了这一步，`type="submit"` 的按钮点下去**什么都不发生**（native submit 找不到所属表单）。
   * `DrawerForm` 一直是这么写的，这里是补齐。
   */
  const formId = useId()
  const prevOpen = useRef(false)
  const fieldNames = collectFieldNames(items)

  // 打开弹窗（或回填值变化）时回填字段
  useEffect(() => {
    if (open && !prevOpen.current && values) {
      for (const name of fieldNames) {
        const value = (values as Record<string, unknown>)[name]
        if (value !== undefined) {
          form.setFieldValue(name as never, value as never, {
            dontUpdateMeta: true,
            dontValidate: true,
          })
        }
      }
    }
    prevOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, values])

  const submit = async () => {
    setSubmitting(true)
    try {
      await form.handleSubmit()
    } catch (error) {
      onError?.(error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (resetOnClose) form.reset()
          onCancel()
        }
      }}
    >
      <DialogContent
        bodyScroll={false}
        className={cn(
          'flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg',
          dialogClassName,
        )}
      >
        {/* 头部：固定不滚动 */}
        <DialogHeader className="shrink-0 bg-surface-1 px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {/* 内容区：说明 + 字段，独立滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {description ? (
            <div className="px-5 pt-4 text-sm text-muted-foreground">{description}</div>
          ) : null}
          <form
            id={formId}
            className="flex flex-col gap-5 px-5 py-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {items ? <FormFields form={form} items={items} /> : children}
          </form>
        </div>

        {/* 底部：固定不滚动 */}
        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none bg-surface-1 px-5 py-3">
          <Button variant="outline" disabled={loading || submitting} onClick={onCancel}>
            {cancelText}
          </Button>
          <Button type="submit" form={formId} disabled={loading || submitting}>
            {submitting ? <Spinner data-icon="inline-start" /> : null}
            {submitText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
