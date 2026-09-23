"use client"

import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useSyncExternalStore } from "react"

import { Button } from "#components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#components/ui/dropdown-menu"
import {
  applyThemeClass,
  PREFERS_DARK_MEDIA_QUERY,
  readStoredMode,
  resolveDark,
  THEME_MODES,
  writeStoredMode,
  type ThemeMode,
} from "#lib/theme"

export type ThemeState = {
  mode: ThemeMode
  dark: boolean
}

export type ThemeApi = ThemeState & {
  setMode: (mode: ThemeMode) => void
  /** 浅色 → 深色 → 跟随系统 → 浅色 */
  cycle: () => void
}

export type ThemeController = {
  /** 订阅主题状态（组件里调用；本身不依赖任何第三方状态库） */
  useTheme: () => ThemeApi
  /** 应用已存储 / 系统的主题，并监听系统偏好变化（在根级 client 组件的 effect 里调用一次） */
  initTheme: () => void
}

/**
 * 创建一套主题能力：**存储 key 与默认模式由调用方传入**。
 *
 * 为什么 key 必须参数化：同域部署多个前端时 localStorage 是共享的，
 * 写死一个 key 会让后台切换深色把前台也改掉（与 `TokenKey` 必须两端不同同一个道理）。
 *
 * 状态放在模块闭包里 + `useSyncExternalStore` 订阅 —— 不引入 zustand，
 * 这样 `@repo/ui` 不必为一个主题开关多背一个依赖。
 *
 * @example
 * ```ts
 * // apps/<app>/src/stores/theme.ts
 * export const { useTheme, initTheme } = createTheme({ storageKey: ThemeKey })
 * ```
 */
export function createTheme(options: {
  storageKey: string
  defaultMode?: ThemeMode
}): ThemeController {
  const { storageKey, defaultMode = "system" } = options

  let state: ThemeState = { mode: defaultMode, dark: false }
  const listeners = new Set<() => void>()

  const commit = (mode: ThemeMode, dark: boolean) => {
    state = { mode, dark }
    for (const listener of listeners) listener()
  }

  const setMode = (mode: ThemeMode) => {
    const dark = resolveDark(mode)
    applyThemeClass(dark)
    writeStoredMode(storageKey, mode)
    commit(mode, dark)
  }

  const initTheme = () => {
    const mode = readStoredMode(storageKey, defaultMode)
    const dark = resolveDark(mode)
    applyThemeClass(dark)
    commit(mode, dark)

    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return
    }
    // 只有 system 模式跟随系统变化；重复调用 initTheme 无副作用（幂等）
    window
      .matchMedia(PREFERS_DARK_MEDIA_QUERY)
      .addEventListener("change", () => {
        if (state.mode !== "system") return
        const nextDark = resolveDark("system")
        applyThemeClass(nextDark)
        commit("system", nextDark)
      })
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  // getSnapshot / cycle 放在闭包里：引用天然稳定（useSyncExternalStore 要求 getSnapshot
  // 稳定），也不会被编译器搬走。**不要**把它们写成传给 useSyncExternalStore 的内联箭头函数
  // —— React Compiler 会把无捕获的内联函数提升到模块级（编译产物里的 `_temp`），而 `state`
  // 是 createTheme 的闭包变量，提升后运行时必然 `state is not defined`。
  const getSnapshot = () => state

  const cycle = () => {
    const index = THEME_MODES.indexOf(state.mode)
    setMode(THEME_MODES[(index + 1) % THEME_MODES.length] as ThemeMode)
  }

  const useTheme = (): ThemeApi => {
    // 服务端快照与服务端渲染一致（默认模式），避免水合不匹配
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    return {
      ...snapshot,
      setMode,
      cycle,
    }
  }

  return { useTheme, initTheme }
}

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof SunIcon }[] = [
  { mode: "light", label: "浅色", icon: SunIcon },
  { mode: "dark", label: "深色", icon: MoonIcon },
  { mode: "system", label: "跟随系统", icon: MonitorIcon },
]

export type ThemeToggleProps = {
  /** 当前模式（来自调用方的 `useTheme()`） */
  mode: ThemeMode
  /** 选中回调（来自调用方的 `useTheme().setMode`） */
  onSelect: (mode: ThemeMode) => void
}

/**
 * 主题切换（浅色 / 深色 / 跟随系统），选中项带对勾。
 *
 * 刻意做成**受控展示组件**：不内置状态，由 app 用自己 `createTheme()` 出来的 hook 接线
 * —— 这样同一个组件能被不同存储 key 的前端复用。
 */
export function ThemeToggle({ mode, onSelect }: ThemeToggleProps) {
  const CurrentIcon =
    OPTIONS.find((option) => option.mode === mode)?.icon ?? MonitorIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`切换主题，当前：${
              OPTIONS.find((option) => option.mode === mode)?.label ?? "跟随系统"
            }`}
          >
            <CurrentIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => (
          <DropdownMenuItem key={optionMode} onClick={() => onSelect(optionMode)}>
            <Icon />
            {label}
            {optionMode === mode ? (
              <CheckIcon className="ml-auto text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
