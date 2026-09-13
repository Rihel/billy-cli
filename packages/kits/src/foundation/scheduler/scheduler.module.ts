import { Global, Module } from '@nestjs/common'
import { Scheduler } from './scheduler.js'

/** 基础能力：定时调度（croner，无配置） */
@Global()
@Module({ providers: [Scheduler], exports: [Scheduler] })
export class SchedulerModule {}
