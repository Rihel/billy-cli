import {
  CredentialImportResponseSchema,
  CredentialResolveResponseSchema,
  type CredentialImportRequest,
  type CredentialImportResponse,
  type CredentialResolveRequest,
  type CredentialResolveResponse,
} from '@repo/contracts'
import { requestEnvelope, type InternalClientOptions, type InvokeOptions } from './http.js'

/**
 * 控制面（main）的内部客户端 —— **下游服务 → main** 的唯一出口。
 *
 * 目前只有一条链：workspace-service 在「容器导入 / 同名凭据同步 / 用户会话里直接给值」
 * 时把值交给 main 加密入库，或按归属主体解析出明文去落环境。
 * 为什么必须走内部接口：解密密钥只在控制面持有，执行面对 `personal_credentials`
 * 只能拿到密文；凭证值不回显、不落日志、不进时间线。
 *
 * 鉴权：main 的 `/internal/*` 认 `TOOL_INTERNAL_TOKEN`（`x-internal-token`），
 * 与 workspace-service 自己的网关令牌不是同一个，调用方勿混用。
 */
export class MainInternalClient {
  constructor(private readonly options: InternalClientOptions) {}

  /** 按主体 + 凭据名批量解析明文（含失效 / 缺失状态，调用方据此给不同提示） */
  resolveCredentials(
    input: CredentialResolveRequest,
    options: InvokeOptions = {},
  ): Promise<CredentialResolveResponse> {
    return requestEnvelope(
      this.options,
      '/internal/credentials/resolve',
      CredentialResolveResponseSchema,
      { method: 'POST', body: input, ...options },
    )
  }

  /** 凭据入库：执行面读到的值交给控制面加密写库（值不回显） */
  importCredential(
    input: CredentialImportRequest,
    options: InvokeOptions = {},
  ): Promise<CredentialImportResponse> {
    return requestEnvelope(
      this.options,
      '/internal/credentials/import',
      CredentialImportResponseSchema,
      { method: 'POST', body: input, ...options },
    )
  }
}
