"use client"

import { createContext, isValidElement, useContext } from "react"
import type {
  ComponentType,
  CSSProperties,
  HTMLAttributes,
  ReactElement,
  ReactNode,
} from "react"
import { useState } from "react"
import { forwardRef } from "react"
import type { MouseEvent } from "react"

import { cn } from "#lib/utils"

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

/** 图标注册表 Provider（可按 name 引用注册表中的图标） */
export function IconProvider({ registry, children }: IconProviderProps) {
  return (
    <IconRegistryContext value={registry}>{children}</IconRegistryContext>
  )
}

export type IconProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children" | "color"
> & {
  icon?: IconSource
  name?: string
  registry?: IconRegistry
  size?: number | string
  color?: CSSProperties["color"]
  spin?: boolean
  fallback?: ReactNode
}

/** 通用图标容器：支持直接传组件 / 元素 / 注册表名称 */
export function Icon({
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
}: IconProps) {
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
        "inline-flex shrink-0 items-center justify-center [&_svg:not([class*='size-'])]:size-[1em]",
        className,
      )}
      style={iconStyle}
    >
      {content}
    </span>
  )
}

export type IconTextType = "default" | "primary" | "danger"

export type IconTextProps = {
  children?: ReactNode
  text?: ReactNode
  icon?: IconSource
  iconName?: string
  iconRegistry?: IconRegistry
  iconPosition?: "left" | "right"
  iconClassName?: string
  loading?: boolean
  disabled?: boolean
  danger?: boolean
  type?: IconTextType | "link" | "text"
  block?: boolean
  size?: "small" | "middle" | "large"
  tooltip?: ReactNode
  onClick?: (event: MouseEvent<HTMLSpanElement>) => void | Promise<void>
  onError?: (error: unknown) => void
  className?: string
  "aria-label"?: string
}

/** 带图标的文字操作（表格行内操作按钮常用），点击支持 loading 防重 */
export const IconText = forwardRef<HTMLSpanElement, IconTextProps>(
  (
    {
      children,
      text,
      icon,
      iconName,
      iconRegistry,
      iconPosition = "left",
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
      type === "primary"
        ? "text-primary hover:text-primary/80"
        : danger || type === "danger"
          ? "text-destructive hover:text-destructive/80"
          : "text-inherit hover:text-primary/80"

    const sizeClass =
      size === "small"
        ? "text-sm gap-0.5"
        : size === "large"
          ? "text-lg gap-1.5"
          : "gap-1"

    const button = (
      <span
        ref={ref}
        role={onClick ? "button" : undefined}
        tabIndex={onClick && !disabled ? 0 : undefined}
        aria-disabled={disabled || isLoading || undefined}
        className={cn(
          "inline-flex items-center cursor-pointer border-none bg-transparent p-0 leading-none",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-40",
          "transition-colors duration-150",
          semanticColor,
          sizeClass,
          block && "w-full justify-center",
          className,
        )}
        onClick={handleClick}
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  handleClick(e as unknown as MouseEvent<HTMLSpanElement>)
                }
              }
            : undefined
        }
        {...rest}
      >
        {iconPosition === "left" && iconNode}
        {children ?? text}
        {iconPosition === "right" && iconNode}
      </span>
    )

    if (tooltip) {
      return (
        <span title={typeof tooltip === "string" ? tooltip : undefined}>
          {button}
        </span>
      )
    }
    return button
  },
)
IconText.displayName = "IconText"
