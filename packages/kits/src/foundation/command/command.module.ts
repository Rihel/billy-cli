import { Global, Module } from '@nestjs/common'
import { CommandRunner } from './command.runner.js'

/**
 * 基础能力：**跨平台命令执行**（无配置）。
 *
 * 与 `SchedulerModule` 同一形态：能力本身不带配置 ——
 * 「允不允许、能跑多久、输出留多少、在哪个目录跑」是**调用方的策略**
 * （当前是 AI 模块的 `agent.command*` 配置），基础设施只提供确定性的机制。
 */
@Global()
@Module({ providers: [CommandRunner], exports: [CommandRunner] })
export class CommandModule {}
