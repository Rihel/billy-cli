'use client'

import type { MouseEvent, ReactNode } from 'react'
import { forwardRef, useState } from 'react'
import { Icon } from './Icon'
import type { IconRegistry, IconSource } from './Icon'
import { cn } from '../../lib/css'

export type IconTextType = 'default' | 'primary' | 'danger'

export type IconTextProps = {
  children?: ReactNode
  text?: ReactNode
  icon?: IconSource
  iconName?: string
  iconRegistry?: IconRegistry
  iconPosition?: 'left' | 'right'
  iconClassName?: string
  loading?: boolean
  disabled?: boolean
  danger?: boolean
  type?: IconTextType | 'link' | 'text'
  block?: boolean
  size?: 'small' | 'middle' | 'large'
  tooltip?: ReactNode
  onClick?: (event: MouseEvent<HTMLSpanElement>) => void | Promise<void>
  onError?: (error: unknown) => void
  className?: string
  'aria-label'?: string
}

export const IconText = forwardRef<HTMLSpanElement, IconTextProps>(
  (
    {
      children,
      text,
      icon,
      iconName,
      iconRegistry,
      iconPosition = 'left',
      iconClassName,
      loading: loadingProp,
      disabled,
      danger,
      type,
      block,
      size,
      tooltip,
      onClick,
      onError,
      className,
      ...rest
    },
    ref,
  ) => {
    const [innerLoading, setInnerLoading] = useState(false)
    const isLoading = loadingProp ?? innerLoading

    const handleClick = async (e: MouseEvent<HTMLSpanElement>) => {
      if (disabled || isLoading || !onClick) return
      setInnerLoading(true)
      try {
        await onClick(e)
      } catch (error) {
        onError?.(error)
        if (!onError) throw error
      } finally {
        setInnerLoading(false)
      }
    }

    const iconNode =
      icon || iconName ? (
        <Icon
          icon={icon}
          name={iconName}
          registry={iconRegistry}
          className={iconClassName}
          spin={isLoading && !loadingProp}
        />
      ) : null

    const semanticColor =
      type === 'primary'
        ? 'text-[#1677ff] hover:text-[#4096ff] active:text-[#0958d5]'
        : danger || type === 'danger'
          ? 'text-[#ff4d4f] hover:text-[#ff7875] active:text-[#d9363e]'
          : 'text-inherit hover:text-[#4096ff] active:text-[#0958d5]'

    const sizeClass =
      size === 'small'
        ? 'text-sm gap-0.5'
        : size === 'large'
          ? 'text-lg gap-1.5'
          : 'gap-1'

    const button = (
      <span
        ref={ref}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick && !disabled ? 0 : undefined}
        aria-disabled={disabled || isLoading || undefined}
        className={cn(
          'inline-flex items-center cursor-pointer border-none bg-transparent p-0 leading-none',
          'aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
          'transition-colors duration-150',
          semanticColor,
          sizeClass,
          block && 'w-full justify-center',
          className,
        )}
        onClick={handleClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleClick(e as unknown as MouseEvent<HTMLSpanElement>)
                }
              }
            : undefined
        }
        {...rest}
      >
        {iconPosition === 'left' && iconNode}
        {children ?? text}
        {iconPosition === 'right' && iconNode}
      </span>
    )

    if (tooltip) {
      return (
        <span title={typeof tooltip === 'string' ? tooltip : undefined}>
          {button}
        </span>
      )
    }
    return button
  },
)
IconText.displayName = 'IconText'
