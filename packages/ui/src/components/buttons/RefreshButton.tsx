'use client'

import { ReloadOutlined } from '@ant-design/icons'
import { Button, Tooltip } from 'antd'
import type { ButtonProps } from 'antd'
import type { ReactNode } from 'react'

export type RefreshButtonProps = Omit<ButtonProps, 'icon' | 'children'> & {
  label?: ReactNode
  tooltip?: ReactNode
}

export const RefreshButton = ({
  label,
  tooltip = '刷新',
  ...buttonProps
}: RefreshButtonProps) => {
  const button = (
    <Button
      {...buttonProps}
      aria-label={buttonProps['aria-label'] ?? '刷新'}
      icon={<ReloadOutlined />}
    >
      {label}
    </Button>
  )

  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button
}
