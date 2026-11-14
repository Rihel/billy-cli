import type { RuntimeModel } from '../core/envelope.js'

/** 运行时模型解析端口（生产 = model-gateway 目录；测试可注入替身） */
export const RUNTIME_MODEL_RESOLVER = Symbol.for('RuntimeModelResolver')

export interface AvailableRuntimeModel {
  id: string
  modelRef: string
}

export interface ModelAttribution {
  runId?: string
  conversationId?: string
  identityType?: 'user' | 'admin'
  identityId?: string
}

export interface RuntimeModelResolver {
  /** 解析这一轮要用的模型（省略 id 取默认）；解析不出来抛 3406 / 3402 */
  resolveForRuntime(modelId?: string, attribution?: ModelAttribution): Promise<RuntimeModel>
  /** 可用模型清单（能力状态 / 选择器用） */
  listAvailable(): Promise<{ models: AvailableRuntimeModel[]; defaultModelId: string | null }>
}
