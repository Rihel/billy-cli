'use client'

import { Button, Popconfirm, Space } from 'antd'
import type { PopconfirmProps } from 'antd'
import type { ReactNode } from 'react'
import { IconText } from '../icon/IconText'

export const TableActions = ({ children }: { children: ReactNode }) => {
  return <div className="flex items-center gap-3">{children}</div>
}

export type ConfirmActionProps = {
  title: ReactNode
  children: ReactNode
  danger?: boolean
  disabled?: boolean
  onConfirm: PopconfirmProps['onConfirm']
}

export const ConfirmAction = ({
  title,
  children,
  danger,
  disabled,
  onConfirm,
}: ConfirmActionProps) => {
  return (
    <Popconfirm
      title={title}
      disabled={disabled}
      okText="确认"
      cancelText="取消"
      okButtonProps={{ danger }}
      onConfirm={onConfirm}
    >
      <IconText type="danger" size="small" disabled={disabled}>
        {children}
      </IconText>
    </Popconfirm>
  )
}
