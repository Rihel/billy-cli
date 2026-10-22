import { Inject, Injectable } from '@nestjs/common'
import { hostname } from 'node:os'
import { MonitorConfig, type MonitorConfig as MonitorConfigType } from '../config.js'

/** 当前进程实例标识：环境变量优先，缺省 hostname:pid */
@Injectable()
export class MonitorInstanceService {
  readonly id: string

  constructor(@Inject(MonitorConfig) config: MonitorConfigType) {
    this.id = config.instanceId ?? `${hostname()}:${process.pid}`
  }
}
