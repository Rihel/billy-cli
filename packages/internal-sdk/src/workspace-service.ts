import {
  WorkspaceDestroyResponseSchema,
  WorkspaceEnsureResponseSchema,
  WorkspaceExecResultSchema,
  WorkspaceEnvironmentSchema,
  WorkspaceFsResultSchema,
  WorkspaceStatusResponseSchema,
  WorkspaceSyncResponseSchema,
  type WorkspaceEnsureResponse,
  type WorkspaceExecRequest,
  type WorkspaceEnvironment,
  type WorkspaceExecResult,
  type WorkspaceFsRequest,
  type WorkspaceFsResult,
  type WorkspaceStatusResponse,
  type WorkspaceSyncResponse,
} from '@repo/contracts'
import { z } from 'zod'
import { requestJson, type InternalClientOptions, type InvokeOptions } from './http.js'

/** `/info` 是排障用的开放结构：这里只保证「是一个对象」，字段由调用方按需读 */
const WorkspaceInfoSchema = z.record(z.string(), z.unknown())

/**
 * workspace-service 的内部客户端（main 的控制面、runtime 的编排用）。
 *
 * 约定同其它内部客户端：只走 typed client，业务代码不自己拼地址与令牌。
 * main 调它做「启动 / 停止 / 销毁 / 查状态」；它**不写 `ai_workspaces`**。
 */
export class WorkspaceServiceClient {
  constructor(private readonly options: InternalClientOptions) {}

  /** 部署级信息（平台 / 沙箱 / 容器运行时）：后台据此提示「当前部署没有沙箱」 */
  info(options: InvokeOptions = {}): Promise<Record<string, unknown>> {
    return requestJson(this.options, '/info', WorkspaceInfoSchema, {
      method: 'GET',
      ...options,
    })
  }

  environment(workspaceId: string, options: InvokeOptions = {}): Promise<WorkspaceEnvironment> {
    return requestJson(this.options, '/v1/workspaces/environment', WorkspaceEnvironmentSchema, {
      method: 'POST',
      body: { workspaceId },
      ...options,
    })
  }

  ensure(workspaceId: string, options: InvokeOptions = {}): Promise<WorkspaceEnsureResponse> {
    return requestJson(this.options, '/v1/workspaces/ensure', WorkspaceEnsureResponseSchema, {
      method: 'POST',
      body: { workspaceId },
      ...options,
    })
  }

  stop(workspaceId: string, options: InvokeOptions = {}): Promise<WorkspaceStatusResponse> {
    return requestJson(this.options, '/v1/workspaces/stop', WorkspaceStatusResponseSchema, {
      method: 'POST',
      body: { workspaceId },
      ...options,
    })
  }

  destroy(workspaceId: string, options: InvokeOptions = {}): Promise<{ removed: boolean }> {
    return requestJson(this.options, '/v1/workspaces/destroy', WorkspaceDestroyResponseSchema, {
      method: 'POST',
      body: { workspaceId },
      ...options,
    })
  }

  status(workspaceId: string, options: InvokeOptions = {}): Promise<WorkspaceStatusResponse> {
    return requestJson(this.options, '/v1/workspaces/status', WorkspaceStatusResponseSchema, {
      method: 'POST',
      body: { workspaceId },
      ...options,
    })
  }

  /** 同步凭据 / 技能到**已在运行**的工作区（绝不 ensure：只查不起） */
  sync(
    workspaceId: string,
    credentialVersion?: string,
    options: InvokeOptions & { skills?: boolean } = {},
  ): Promise<WorkspaceSyncResponse> {
    const { skills, ...rest } = options
    return requestJson(this.options, '/v1/workspaces/sync', WorkspaceSyncResponseSchema, {
      method: 'POST',
      body: {
        workspaceId,
        ...(credentialVersion ? { credentialVersion } : {}),
        ...(skills ? { skills } : {}),
      },
      ...rest,
    })
  }

  exec(request: WorkspaceExecRequest, options: InvokeOptions = {}): Promise<WorkspaceExecResult> {
    return requestJson(this.options, '/v1/workspaces/exec', WorkspaceExecResultSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }

  fs(request: WorkspaceFsRequest, options: InvokeOptions = {}): Promise<WorkspaceFsResult> {
    return requestJson(this.options, '/v1/workspaces/fs', WorkspaceFsResultSchema, {
      method: 'POST',
      body: request,
      ...options,
    })
  }
}
