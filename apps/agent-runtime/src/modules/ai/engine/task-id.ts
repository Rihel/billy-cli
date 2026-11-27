import { nanoid } from '@repo/shared'

/** 一次用户目标的逻辑任务 id；根 run 生成，子 run 继承 */
export const createTaskId = (): string => `task_${nanoid(16)}`
