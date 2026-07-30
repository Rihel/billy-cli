'use client'

import { createContext, isValidElement, useContext } from 'react'
import type {
  ComponentType,
  CSSProperties,
  HTMLAttributes,
  ReactElement,
  ReactNode,
} from 'react'
import { cn } from '../../lib/css'

export type IconComponent = ComponentType<{
  spin?: boolean
  className?: string
  style?: CSSProperties
}>
export type IconSource = IconComponent | ReactElement
export type IconRegistry = Record<string, IconSource>

const IconRegistryContext = createContext<IconRegistry>({})

export type IconProviderProps = {
  registry: IconRegistry
  children: ReactNode
}

export const IconProvider = ({ registry, children }: IconProviderProps) => (
  <IconRegistryContext value={registry}>{children}</IconRegistryContext>
)

export type IconProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  'children' | 'color'
> & {
  icon?: IconSource
  name?: string
  registry?: IconRegistry
  size?: number | string
  color?: CSSProperties['color']
  spin?: boolean
  fallback?: ReactNode
}

export const Icon = ({
  icon,
  name,
  registry,
  size,
  color,
  spin = false,
  fallback = null,
  className,
  style,
  ...spanProps
}: IconProps) => {
  const contextRegistry = useContext(IconRegistryContext)
  const source =
    icon ?? (name ? (registry?.[name] ?? contextRegistry[name]) : null)

  if (!source) return fallback

  const iconStyle = { fontSize: size, color, ...style }
  const content = isValidElement(source)
    ? source
    : (() => {
        const IconComponent = source as IconComponent
        return <IconComponent spin={spin} />
      })()

  return (
    <span
      {...spanProps}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        className,
      )}
      style={iconStyle}
    >
      {content}
    </span>
  )
}
