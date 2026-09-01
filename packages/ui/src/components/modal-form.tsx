"use client"

import { useState } from "react"
import type { ReactNode } from "react"
import type { AnyFormApi } from "#components/form"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#components/ui/dialog"
import { FormFields } from "#components/form"
import type { FormFieldSchema } from "#components/form"
import { Spinner } from "#components/ui/spinner"

export type ModalFormProps<Values extends object> = {
  open: boolean
  title: ReactNode
  /** @tanstack/react-form 的 useForm 实例（onSubmit 在 useForm 中定义） */
  form: AnyFormApi<Values>
  children?: ReactNode
  items?: Array<FormFieldSchema<Values> | FormFieldSchema<Values>[]>
  /** 标题下方的说明文案 */
  description?: ReactNode
  /** 提交中状态（外部 mutation 进行中） */
  loading?: boolean
  /** 关闭时是否重置表单（默认 true） */
  resetOnClose?: boolean
  submitText?: string
  cancelText?: string
  dialogClassName?: string
  onCancel: () => void
  onError?: (error: unknown) => void
}

/** 弹窗表单（Dialog + @tanstack/react-form）：声明式 items 或自定义 children */
export function ModalForm<Values extends object>({
  open,
  title,
  form,
  children,
  items,
  description,
  loading,
  resetOnClose = true,
  submitText = "提交",
  cancelText = "取消",
  dialogClassName,
  onCancel,
  onError,
}: ModalFormProps<Values>) {
  const [submitting, setSubmitting] = useState(false)

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
      <DialogContent className={cn("sm:max-w-lg", dialogClassName)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {items ? <FormFields form={form} items={items} /> : children}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={loading || submitting}
              onClick={onCancel}
            >
              {cancelText}
            </Button>
            <Button type="submit" disabled={loading || submitting}>
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              {submitText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
