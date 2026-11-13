import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common'
import type { z } from 'zod'
import { WORKSPACE_PROBE, WorkspaceConfig, WorkspaceConfigSchema } from './workspace.config.js'
import { WorkspaceRuntimeService, defaultSandboxProbe } from './workspace.runtime.js'

/** WorkspaceModule.forRoot 入参 = WorkspaceConfigSchema 的输入类型 */
export type WorkspaceModuleOptions = z.input<typeof WorkspaceConfigSchema>

/** 两个装配入口共用的 provider（差异只有 `WorkspaceConfig` 的来源） */
const withRuntime = (configProvider: Provider): Provider[] => [
  configProvider,
  // 探测实现：生产用真探测，测试可整体替换这个 token
  { provide: WORKSPACE_PROBE, useValue: defaultSandboxProbe },
  WorkspaceRuntimeService,
]

/**
 * 工作区运行时模块：`forRoot(options)` / `forRootAsync(options)` 自带配置 bean
 * （`WorkspaceConfig`）—— 配置即模块自身注入的 provider，未 import 即未装配。
 */
@Global()
@Module({})
export class WorkspaceModule {
  static forRoot(options: WorkspaceModuleOptions): DynamicModule {
    return {
      module: WorkspaceModule,
      providers: withRuntime({
        provide: WorkspaceConfig,
        useValue: WorkspaceConfigSchema.parse(options),
      }),
      exports: [WorkspaceConfig, WORKSPACE_PROBE, WorkspaceRuntimeService],
    }
  }

  /** 异步装配：配置由 `ConfigService` 惰性解析，避免模块装饰器求值早于配置加载 */
  static forRootAsync(options: InfraModuleAsyncOptions<WorkspaceModuleOptions>): DynamicModule {
    return {
      module: WorkspaceModule,
      imports: options.imports ?? [],
      providers: withRuntime({
        provide: WorkspaceConfig,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      }),
      exports: [WorkspaceConfig, WORKSPACE_PROBE, WorkspaceRuntimeService],
    }
  }
}
