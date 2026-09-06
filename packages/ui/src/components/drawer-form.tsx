"use client"

import { useId, useState } from "react"
import type { ReactNode } from "react"
import type { AnyFormApi } from "#components/form"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import { FormFields } from "#components/form"
import type { FormItem } from "#components/form"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "#components/ui/sheet"
import { Spinner } from "#components/ui/spinner"

/** Drawer 宽度（px）→ tailwind 类（需字面量，便于 tailwind 扫描） */
const WIDTH_CLASS: Record<number, string> = {
  480: "sm:max-w-[480px]",
  520: "sm:max-w-[520px]",
  560: "sm:max-w-[560px]",
  640: "sm:max-w-[640px]",
}

export type DrawerFormProps<Values extends object> = {
  open: boolean
  title: ReactNode
  /** @tanstack/react-form 的 useForm 实例（onSubmit 在 useForm 中定义） */
  form: AnyFormApi<Values>
  children?: ReactNode
  items?: Array<FormItem<Values>>
  /** 表单上方的说明区（如配置指引 / 提示文案） */
  description?: ReactNode
  /** Drawer 宽度（默认 480） */
  width?: number
  /** 提交中状态（外部 mutation 进行中） */
  loading?: boolean
  resetOnClose?: boolean
  /** 提交按钮文案（默认「提交」） */
  submitText?: string
  cancelText?: string
  onCancel: () => void
  onError?: (error: unknown) => void
}

/** 侧滑抽屉表单（Sheet + @tanstack/react-form），声明式 items 与 ModalForm 同构 */
export function DrawerForm<Values extends object>({
  open,
  title,
  form,
  children,
  items,
  description,
  width = 480,
  loading,
  resetOnClose = true,
  submitText = "提交",
  cancelText = "取消",
  onCancel,
  onError,
}: DrawerFormProps<Values>) {
  const [submitting, setSubmitting] = useState(false)
  const formId = useId()

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
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (resetOnClose) form.reset()
          onCancel()
        }
      }}
    >
      <SheetContent
        className={cn("flex max-h-dvh flex-col gap-0 overflow-hidden p-0", WIDTH_CLASS[width])}
      >
        {/* 头部：固定不滚动 */}
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        {/* 内容区：说明 + 字段，独立滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {description ? (
            <div className="px-4 pt-4 text-sm text-muted-foreground">
              {description}
            </div>
          ) : null}
          <form
            id={formId}
            className="flex flex-col gap-5 px-4 py-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {items ? <FormFields form={form} items={items} /> : children}
          </form>
        </div>
        {/* 底部：固定不滚动 */}
        <div className="flex shrink-0 justify-end gap-2 border-t bg-muted/40 px-4 py-3">
          <Button
            variant="outline"
            disabled={loading || submitting}
            onClick={onCancel}
          >
            {cancelText}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={loading || submitting}
          >
            {submitting ? <Spinner data-icon="inline-start" /> : null}
            {submitText}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
