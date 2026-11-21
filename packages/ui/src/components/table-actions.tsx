'use client'

import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#components/ui/alert-dialog'
import { IconText } from '#components/icon'

/** 表格行内操作容器 */
export const TableActions = ({ children }: { children: ReactNode }) => {
  return <div className="flex items-center gap-3">{children}</div>
}

export type ConfirmActionProps = {
  title: ReactNode
  description?: ReactNode
  /** 触发器内容（默认渲染成 IconText 文字操作） */
  children: ReactNode
  /**
   * 自定义触发器（图标按钮 / 页头按钮用）；给了就替代默认的 IconText。
   *
   * Base UI 的 Trigger 会把开合行为 merge 到这个元素上，所以元素自己只管外观。
   */
  trigger?: ReactElement
  danger?: boolean
  disabled?: boolean
  okText?: string
  cancelText?: string
  onConfirm: () => void | Promise<void>
}

/** 删除 / 危险操作确认（AlertDialog 封装） */
export function ConfirmAction({
  title,
  description,
  children,
  trigger,
  danger,
  disabled,
  okText = '确认',
  cancelText = '取消',
  onConfirm,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={(next) => setOpen(next)}>
      {trigger === undefined ? (
        <IconText
          type={danger ? 'danger' : 'default'}
          danger={danger}
          disabled={disabled}
          onClick={() => {
            if (!disabled) setOpen(true)
          }}
        >
          {children}
        </IconText>
      ) : (
        <AlertDialogTrigger render={trigger} />
      )}
      <AlertDialogContent size={danger ? 'sm' : 'default'}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            variant={danger ? 'destructive' : 'default'}
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault()
              setSubmitting(true)
              // 确认回调可能是异步的；用同步包装保持 onClick 的 void 契约
              void (async () => {
                try {
                  await onConfirm()
                  setOpen(false)
                } finally {
                  setSubmitting(false)
                }
              })()
            }}
          >
            {okText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
