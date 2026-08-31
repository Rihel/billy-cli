import type { AppContext } from '@repo/di';
import {
  CreateAlertRuleSchema,
  GetAlertRuleDetailSchema,
  PageQueryAlertLogSchema,
  PageQueryAlertRuleSchema,
  RemoveAlertRuleSchema,
  TestAlertSchema,
  UpdateAlertRuleSchema,
} from '@repo/shared';
import { Db, RedisStore } from '@repo/kits';
import { Hono } from 'hono';
import { makeRequireAdminAuth } from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';
import { AlertRuleService } from '../modules/monitor/index.js';
import { MonitorService } from '../modules/monitor/index.js';
import { AlertLogRepository } from '../modules/monitor/index.js';

/**
 * 监控告警路由（`/monitor/*`，除 /health 外全部 admin 鉴权）：
 * - GET  /monitor/health        健康检查（免鉴权，供 Docker / k8s / 云平台探针）
 * - POST /monitor/rule/*        告警规则 CRUD（admin 管理）
 * - POST /monitor/log/page-query 告警记录查询（审计）
 * - POST /monitor/test          测试通知（手动验证通道）
 */
export const makeMonitorRoutes = (runtime: AppContext) => {
  const alertRuleService = runtime.get(AlertRuleService);
  const monitorService = runtime.get(MonitorService);
  const alertLogRepository = runtime.get(AlertLogRepository);
  const requireAdminAuth = makeRequireAdminAuth(runtime);
  const routes = new Hono();

  // 健康检查：探活 DB / Redis，任一失败 degraded（不抛错；统一 POST 约定）
  routes.post('/health', async (context) => {
    const checks: Record<string, 'ok' | 'failed'> = {};
    let status: 'ok' | 'degraded' = 'ok';

    try {
      await runtime.get(Db).dataSource.query('SELECT 1');
      checks.db = 'ok';
    } catch {
      checks.db = 'failed';
      status = 'degraded';
    }
    try {
      await runtime.get(RedisStore).raw.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'failed';
      status = 'degraded';
    }

    return success(context, {
      status,
      uptimeSeconds: Math.round(process.uptime()),
      checks,
    });
  });

  routes.use('*', requireAdminAuth);

  routes
    .post('/rule/create', jsonBody(CreateAlertRuleSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await alertRuleService.create(input));
    })
    .post('/rule/page-query', jsonBody(PageQueryAlertRuleSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await alertRuleService.page(input));
    })
    .post('/rule/detail', jsonBody(GetAlertRuleDetailSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await alertRuleService.get(input));
    })
    .post('/rule/update', jsonBody(UpdateAlertRuleSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await alertRuleService.update(input));
    })
    .post('/rule/remove', jsonBody(RemoveAlertRuleSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await alertRuleService.remove(input));
    })
    .post('/log/page-query', jsonBody(PageQueryAlertLogSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await alertLogRepository.page(input));
    })
    .post('/test', jsonBody(TestAlertSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await monitorService.testNotify(input));
    });

  return routes;
};
