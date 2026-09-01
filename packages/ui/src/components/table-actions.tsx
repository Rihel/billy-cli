"use client"

import { useState } from "react"
import type { ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#components/ui/alert-dialog"
import { IconText } from "#components/icon"

/** 表格行内操作容器 */
export const TableActions = ({ children }: { children: ReactNode }) => {
  return <div className="flex items-center gap-3">{children}</div>
}

export type ConfirmActionProps = {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
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
  danger,
  disabled,
  okText = "确认",
  cancelText = "取消",
  onConfirm,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={(next) => setOpen(next)}>
      <IconText
        type={danger ? "danger" : "default"}
        danger={danger}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(true)
        }}
      >
        {children}
      </IconText>
      <AlertDialogContent size={danger ? "sm" : "default"}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            variant={danger ? "destructive" : "default"}
            disabled={submitting}
            onClick={async (event) => {
              event.preventDefault()
              setSubmitting(true)
              try {
                await onConfirm()
                setOpen(false)
              } finally {
                setSubmitting(false)
              }
            }}
          >
            {okText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
