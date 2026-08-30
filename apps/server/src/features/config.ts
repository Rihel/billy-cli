import type { AppContext } from '@repo/di';
import { Hono } from 'hono';
import { ServerConfig, type ServerConfig as ServerConfigType } from '../config.js';
import { success } from '../lib/http.js';

/**
 * 应用运行配置路由（公开，无鉴权）：
 * 前端启动时调用 /config/get 获取用户体系开关等运行配置，据此控制 UI。
 */
export const makeConfigRoutes = (runtime: AppContext) => {
  const routes = new Hono();

  routes.post('/get', async (context) => {
    const config = runtime.get<ServerConfigType>(ServerConfig);
    return success(context, { authEnabled: config.authEnabled });
  });

  return routes;
};
