import { FileTools } from '../../src/modules/ai/files/file.tools.js'

/** 只做声明层测试的 FileTools：执行体依赖的 service / storage 在这里不需要真实现 */
export const buildFileTools = (): FileTools =>
  new FileTools({} as never, { enabled: true } as never)
