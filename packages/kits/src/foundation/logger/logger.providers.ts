/**
 * DI token：应用级基础日志统一入口。
 *
 * 它是**整应用唯一的 pino 实例**——pino 的 `transport` 会为每个实例拉起一个 worker 线程，
 * 所以只能建一次；需要带 context 的日志一律用它 `child(context)` 派生（见 `AppLogger` /
 * `NestLoggerAdapter`），不要重复 `createLogger()`。
 */
export const LOGGER_INSTANCE = Symbol.for('LoggerInstance')
