'use client'

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui'
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useThemeStore, type ThemeMode } from '@/stores/theme.store'

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof SunIcon }[] = [
  { mode: 'light', label: '浅色', icon: SunIcon },
  { mode: 'dark', label: '深色', icon: MoonIcon },
  { mode: 'system', label: '跟随系统', icon: MonitorIcon },
]

/** 主题切换（浅色 / 深色 / 跟随系统），选中项带对勾 */
export function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
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
              OPTIONS.find((option) => option.mode === mode)?.label ?? '跟随系统'
            }`}
          >
            <CurrentIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => (
          <DropdownMenuItem
            key={optionMode}
            onClick={() => setMode(optionMode)}
          >
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
