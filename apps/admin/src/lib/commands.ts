'use client'

import { useSyncExternalStore } from 'react'

export type CommandAction = {
  /** 显示名（如「新建用户」） */
  label: string
  /** 图标名（CommandMenu 内映射；未映射时省略） */
  icon?: 'plus' | 'pencil' | 'refresh' | 'trash'
  /** 分组名（如「用户管理」） */
  group: string
  run: () => void
}

type Listener = () => void

let actions: CommandAction[] = []
const listeners = new Set<Listener>()

const emit = () => listeners.forEach((l) => l())

/** 注册一个全局命令动作（页面挂载时调用，返回注销函数） */
export function registerCommand(action: CommandAction): () => void {
  actions = [...actions, action]
  emit()
  return () => {
    actions = actions.filter((a) => a !== action)
    emit()
  }
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// 快照读取器取模块级常量（引用天然稳定）：不要写成内联 `() => actions` —— 那样要靠 React
// Compiler 把它提升到模块级才稳定，一旦 actions 挪进闭包就会变成 `actions is not defined`
// （同 theme.tsx 的坑）。
const getActions = () => actions

/** 订阅已注册的全局命令（CommandMenu 使用） */
export function useCommands(): CommandAction[] {
  return useSyncExternalStore(subscribe, getActions, getActions)
}
