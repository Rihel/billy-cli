import type { ToolClock } from './tools.types.js'

/** 系统时钟（生产装配用它；测试给固定值） */
export const systemToolClock: ToolClock = { now: () => Date.now() }
