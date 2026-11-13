'use client'

/* oxlint-disable jsx-a11y/no-autofocus -- 弹窗打开 / 进入编辑即聚焦首个输入框，键盘用户可直接输入 */

import type { ReactNode } from 'react'
import { useImmer } from 'use-immer'

import { cn } from '#lib/utils'
import { Input } from '#components/ui/input'
import { IconText } from '#components/icon'
import { CheckIcon, PencilIcon, XIcon } from 'lucide-react'

export type EditableInputProps = {
  value?: string | null
  children?: ReactNode
  disabled?: boolean
  placeholder?: string
  emptyText?: ReactNode
  className?: string
  inputProps?: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'disabled'>
  onChange?: (value: string) => void | Promise<void>
  onError?: (error: unknown) => void
}

/** 行内可编辑文本：点击编辑图标切换为输入框，回车保存 / Esc 取消 */
export function EditableInput({
  value,
  children,
  disabled,
  placeholder,
  emptyText = '-',
  className,
  inputProps,
  onChange,
  onError,
}: EditableInputProps) {
  const [state, updateState] = useImmer({
    editing: false,
    draft: '',
    saving: false,
  })
  const { editing, draft, saving } = state

  const cancel = () => {
    updateState((draftState) => {
      draftState.editing = false
      draftState.draft = ''
    })
  }

  const save = async () => {
    updateState((draftState) => {
      draftState.saving = true
    })
    try {
      await onChange?.(draft)
      cancel()
    } catch (error) {
      onError?.(error)
    } finally {
      updateState((draftState) => {
        draftState.saving = false
      })
    }
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {editing ? (
        // 进入编辑态即聚焦输入框，属有意的交互
        <Input
          autoFocus
          {...inputProps}
          disabled={saving}
          placeholder={placeholder}
          value={draft}
          onChange={(event) =>
            updateState((draftState) => {
              draftState.draft = event.target.value
            })
          }
          onKeyDown={(event) => {
            inputProps?.onKeyDown?.(event)
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') cancel()
          }}
        />
      ) : (
        <span>{children ?? value ?? emptyText}</span>
      )}
      <div className="flex items-center gap-3">
        {editing ? (
          <>
            <IconText
              aria-label="保存"
              type="primary"
              icon={<CheckIcon />}
              loading={saving}
              onClick={() => void save()}
            />
            <IconText
              aria-label="取消"
              type="danger"
              danger
              disabled={saving}
              icon={<XIcon />}
              onClick={cancel}
            />
          </>
        ) : (
          <IconText
            aria-label="编辑"
            type="primary"
            disabled={disabled}
            icon={<PencilIcon />}
            onClick={() => {
              updateState((draftState) => {
                draftState.draft = value ?? ''
                draftState.editing = true
              })
            }}
          />
        )}
      </div>
    </div>
  )
}
