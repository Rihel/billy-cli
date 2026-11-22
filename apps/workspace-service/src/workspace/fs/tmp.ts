import { randomBytes } from 'node:crypto'

/** 原子写的临时文件后缀（同目录内 `rename` 才是原子的，不跨目录） */
export const tmpSuffix = (): string => `.billy-tmp-${randomBytes(4).toString('hex')}`
