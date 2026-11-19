import {
  WorkspaceDestroyResponseSchema,
  WorkspaceEnsureResponseSchema,
  WorkspaceExecResultSchema,
  WorkspaceFsResultSchema,
  WorkspaceStatusResponseSchema,
  type WorkspaceEnsureResponse,
  type WorkspaceExecRequest,
  type WorkspaceExecResult,
  type WorkspaceFsRequest,
  type WorkspaceFsResult,
  type WorkspaceStatusResponse,
} from '@repo/contracts'
import { requestJson, type InternalClientOptions, type InvokeOptions } from './http.js'

/**
 * workspace-service 的内部客户端（main 的控制面、runtime 的编排用）。
 *
 * 约定同其它内部客户端：只走 typed client，业务代码不自己拼地址与令牌。
 * main 调它做「启动 / 停止 / 销毁 / 查状态」；它**不写 `ai_workspaces`**。
 */
export class WorkspaceServiceClient {
  constructor(private readonly options: InternalClientOptions) {}

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
