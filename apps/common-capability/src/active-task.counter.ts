import { Injectable } from '@nestjs/common'

/**
 * 在跑任务计数：心跳上报给网关做负载均衡。
 *
 * 不做服务发现、不写 Redis 注册表——那套已经被能力登记取代。
 */
@Injectable()
export class ActiveTaskCounter {
  private active = 0

  get activeCount(): number {
    return this.active
  }

  acquire(): void {
    this.active += 1
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }
}
