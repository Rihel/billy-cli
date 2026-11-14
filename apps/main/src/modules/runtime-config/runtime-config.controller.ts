import { Controller, HttpCode, Inject, Post } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { resolveServerConfig, type ServerConfig } from '../../config.js'

/**
 * 应用运行配置路由（/config/*，公开无鉴权）：
 * 前端启动时调用 /config/get 获取用户体系开关等运行配置，据此控制 UI。
 */
@Controller('config')
export class RuntimeConfigController {
  /** 应用级业务配置（bootstrap 前已加载校验，构造期解析一次即可） */
  private readonly server: ServerConfig

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.server = resolveServerConfig(config)
  }

  @Post('get')
  @HttpCode(200)
  get() {
    return { authEnabled: this.server.authEnabled }
  }
}
