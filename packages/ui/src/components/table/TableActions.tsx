'use client'

import { Button, Popconfirm, Space } from 'antd'
import type { PopconfirmProps } from 'antd'
import type { ReactNode } from 'react'

export const TableActions = ({ children }: { children: ReactNode }) => {
  return <Space size={4}>{children}</Space>
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
      <Button type="link" size="small" danger={danger} disabled={disabled}>
        {children}
      </Button>
    </Popconfirm>
  )
}
