'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@repo/ui'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '#components/ui/command'
import {
  ActivityIcon,
  BellRingIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  SunIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react'
import { useThemeStore, type ThemeMode } from '@/stores/theme.store'
import { useCommands } from '@/lib/commands'

type CommandItemData = {
  label: string
  hint?: string
  icon?: React.ComponentType<{ className?: string }>
  run: () => void
}

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: typeof SunIcon }[] =
  [
    { mode: 'light', label: '切换为浅色', icon: SunIcon },
    { mode: 'dark', label: '切换为深色', icon: MoonIcon },
    { mode: 'system', label: '跟随系统', icon: MonitorIcon },
  ]

/**
 * 全局命令面板（桌面应用感）：⌘K / Ctrl+K 唤起。
 * 分组：导航（后台全部页面）+ 外观（主题切换）。
 * - header 形态：放大镜胶囊（顶栏）；
 * - sidebar 形态：嵌在侧栏 logo 下（SidebarMenuButton，折叠态自动收窄为图标）。
 */
export function CommandMenu({ sidebar = false }: { sidebar?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const setMode = useThemeStore((s) => s.setMode)
  const actions = useCommands()

  // 页面注册的快捷动作 → 按分组聚合
  const actionGroups = actions.reduce<Record<string, CommandItemData[]>>(
    (acc, action) => {
      const items = acc[action.group] ?? (acc[action.group] = [])
      items.push({
        label: action.label,
        run: () => {
          setOpen(false)
          action.run()
        },
      })
      return acc
    },
    {},
  )

  // 全局快捷键
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const go = (path: string) => {
    setOpen(false)
    router.push(path)
  }

  const pages: CommandItemData[] = [
    { label: '控制台', icon: LayoutDashboardIcon, run: () => go('/main/dashboard') },
    { label: '任务管理', icon: ListTodoIcon, run: () => go('/main/todo') },
    { label: '自动化', icon: TerminalIcon, run: () => go('/main/automation') },
    { label: '告警规则', icon: BellRingIcon, run: () => go('/main/monitor/rules') },
    { label: '告警记录', icon: ActivityIcon, run: () => go('/main/monitor/logs') },
    { label: '用户管理', icon: UsersIcon, run: () => go('/main/system/users') },
    { label: '管理员管理', icon: ShieldCheckIcon, run: () => go('/main/system/admins') },
    { label: '个人中心', icon: UserRoundIcon, run: () => go('/main/user-center') },
  ]

  return (
    <>
      {sidebar ? (
        /* 侧栏入口：logo 下方的搜索按钮（折叠态自动收窄为图标 + tooltip） */
        <SidebarMenu className="gap-1 px-2">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="搜索页面 (⌘K)"
              className="group/search h-8 rounded-lg border border-border/80 bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground data-[active=true]:bg-muted/60"
              onClick={() => setOpen(true)}
            >
              <SearchIcon />
              <span className="flex-1 text-left">搜索页面…</span>
              <kbd className="pointer-events-none ml-auto hidden font-mono text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden md:inline-flex">
                ⌘K
              </kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      ) : (
        <>
          {/* 顶栏入口：放大镜胶囊 */}
          <Button
            variant="outline"
            className="hidden h-8 w-56 justify-start gap-2 rounded-lg border-border bg-background/60 px-2.5 text-sm font-normal text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground sm:flex"
            onClick={() => setOpen(true)}
          >
            <SearchIcon className="size-3.5" />
            <span className="flex-1 text-left">搜索页面…</span>
            <kbd className="pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border border-border bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground">
              ⌘K
            </kbd>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="sm:hidden"
            aria-label="打开命令面板"
            onClick={() => setOpen(true)}
          >
            <SearchIcon />
          </Button>
        </>
      )}

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="命令面板"
        description="搜索页面或执行操作"
        className="top-[18%] max-w-lg"
      >
        <Command>
          <CommandInput placeholder="输入页面名称…" />
          <CommandList>
            <CommandEmpty>没有匹配的页面</CommandEmpty>
            <CommandGroup heading="页面">
              {pages.map((item) => (
                <CommandItem
                  key={item.label}
                  value={item.label}
                  onSelect={item.run}
                  className="gap-2.5"
                >
                  {item.icon ? (
                    <item.icon className="size-4 text-muted-foreground" />
                  ) : null}
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {Object.entries(actionGroups).map(([group, items]) => (
              <CommandGroup key={group} heading={group}>
                {items.map((item) => (
                  <CommandItem
                    key={item.label}
                    value={item.label}
                    onSelect={item.run}
                    className="gap-2.5"
                  >
                    <span className="grid size-4 place-items-center text-muted-foreground">
                      <PlusIcon className="size-3.5" />
                    </span>
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <CommandGroup heading="外观">
              {THEME_OPTIONS.map((option) => (
                <CommandItem
                  key={option.mode}
                  value={option.label}
                  onSelect={() => {
                    setMode(option.mode)
                    setOpen(false)
                  }}
                  className="gap-2.5"
                >
                  <option.icon className="size-4 text-muted-foreground" />
                  <span>{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
