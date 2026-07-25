'use client'

import { CloseOutlined, EditOutlined, SaveOutlined } from '@ant-design/icons'
import { Button, Input } from 'antd'
import type { InputProps } from 'antd'
import type { ReactNode } from 'react'
import { useImmer } from 'use-immer'
import { cn } from '../lib/css'

export type EditableInputProps = {
  value?: string | null
  children?: ReactNode
  disabled?: boolean
  placeholder?: string
  emptyText?: ReactNode
  className?: string
  inputProps?: Omit<InputProps, 'value' | 'onChange' | 'disabled'>
  onChange?: (value: string) => void | Promise<void>
  onError?: (error: unknown) => void
}

export const EditableInput = ({
  value,
  children,
  disabled,
  placeholder,
  emptyText = '-',
  className,
  inputProps,
  onChange,
  onError,
}: EditableInputProps) => {
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
        <Input
          {...inputProps}
          autoFocus
          disabled={saving}
          placeholder={placeholder}
          value={draft}
          onChange={(event) =>
            updateState((draftState) => {
              draftState.draft = event.target.value
            })
          }
          onPressEnter={() => void save()}
          onKeyDown={(event) => {
            inputProps?.onKeyDown?.(event)
            if (event.key === 'Escape') cancel()
          }}
        />
      ) : (
        <span>{children ?? value ?? emptyText}</span>
      )}
      <div className="flex items-center gap-1">
        {editing ? (
          <>
            <Button
              aria-label="保存"
              type="text"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void save()}
            />
            <Button
              aria-label="取消"
              type="text"
              danger
              disabled={saving}
              icon={<CloseOutlined />}
              onClick={cancel}
            />
          </>
        ) : (
          <Button
            aria-label="编辑"
            type="text"
            disabled={disabled}
            icon={<EditOutlined />}
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
