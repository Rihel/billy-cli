'use client'

import { createTheme } from '@repo/ui'
import { ThemeKey } from '@/lib/constants'

/**
 * 前台主题：能力（三态判定 / 持久化 / `.dark` 切换 / 系统偏好监听）在 `@repo/ui` 的
 * `createTheme`，这里只提供**本应用的存储 key** —— 同域部署时 localStorage 共享，
 * 前后台各用各的 key，互不干扰。
 */
export const { useTheme, initTheme } = createTheme({ storageKey: ThemeKey })
