'use client'

import { useBoolean } from 'ahooks'
import { Button, Tooltip } from 'antd'
import type { ButtonProps } from 'antd'
import type { MouseEvent, ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconRegistry, IconSource } from './Icon'

export type IconTextProps = Omit<
  ButtonProps,
  'children' | 'icon' | 'loading' | 'onClick'
> & {
  children?: ReactNode
  text?: ReactNode
  icon?: IconSource
  iconName?: string
  iconRegistry?: IconRegistry
  iconPosition?: 'left' | 'right'
  iconClassName?: string
  loading?: boolean
  autoLoading?: boolean
  tooltip?: ReactNode
  onClick?: (event: MouseEvent<HTMLElement>) => void | Promise<void>
  onError?: (error: unknown) => void
}

export const IconText = ({
  children,
  text,
  icon,
  iconName,
  iconRegistry,
  iconPosition = 'left',
  iconClassName,
  loading,
  autoLoading = true,
  tooltip,
  type = 'link',
  onClick,
  onError,
  ...buttonProps
}: IconTextProps) => {
  const [innerLoading, { setTrue: startLoading, setFalse: stopLoading }] =
    useBoolean()
  const iconNode =
    icon || iconName ? (
      <Icon
        icon={icon}
        name={iconName}
        registry={iconRegistry}
        className={iconClassName}
      />
    ) : null

  const button = (
    <Button
      {...buttonProps}
      type={type}
      loading={loading ?? innerLoading}
      icon={iconPosition === 'left' ? iconNode : undefined}
      onClick={async (event) => {
        if (!onClick) return
        if (autoLoading) startLoading()
        try {
          await onClick(event)
        } catch (error) {
          onError?.(error)
          if (!onError) throw error
        } finally {
          if (autoLoading) stopLoading()
        }
      }}
    >
      {children ?? text}
      {iconPosition === 'right' ? iconNode : null}
    </Button>
  )

  return tooltip ? <Tooltip title={tooltip}>{button}</Tooltip> : button
}
