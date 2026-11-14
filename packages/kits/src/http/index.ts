/**
 * 横切 HTTP 构件（不依赖任何业务模块，业务模块可反向依赖；技术告警经 `ERROR_ALERT_HOOK`
 * 由 app 组合根注入实现）：
 *
 * - `error/`            错误语义与全局异常处理（错误码映射 / 边界错误 / 异常过滤器 / 告警钩子）
 * - `request-context/`  请求上下文**模块**（ALS + 自注册中间件：requestId / 身份）
 * - `request-logger/`   请求日志**模块**（自注册中间件：method / url / status / 耗时 / 身份）
 * - `request-metrics/`  请求指标**模块**（自注册埋点中间件：QPS / 耗时直方图）
 * - 本层根目录         Nest 全局 HTTP 构件（Zod 校验管道 / 响应信封拦截器 / 运维探针路径）
 *
 * 组内文件用相对深层路径互相引用，外部一律从 `@repo/kits` 导入。
 * main / agent-runtime 两个进程共用这一份：以前各自 `src/common/` 存一份，改一处漏一处。
 */
export * from './error/index.js'
export * from './request-context/index.js'
export * from './request-logger/index.js'
export * from './request-metrics/index.js'
export * from './ops-probe.js'
export * from './response-envelope.interceptor.js'
export * from './zod-validation.js'
