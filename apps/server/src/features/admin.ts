import { AdminService, type AppContext } from '@repo/core';
import {
  AdminLoginSchema,
  ChangePasswordSchema,
  CreateAdminSchema,
  GetAdminDetailSchema,
  PageQueryAdminDto,
  RemoveAdminSchema,
  ResetAdminPasswordSchema,
  UpdateAdminSchema,
  UpdateInfoSchema,
} from '@repo/shared';
import { Hono } from 'hono';
import {
  extractToken,
  makeRequireAdminAuth,
} from '../lib/authentication.js';
import { jsonBody, success } from '../lib/http.js';
import { requestContext } from '../lib/request-context.js';

const currentAdminId = (): string => {
  const adminId = requestContext.get('adminId');
  if (!adminId) {
    throw new Error('Authenticated admin request context is unavailable');
  }
  return adminId;
};

export const makeAdminRoutes = (runtime: AppContext) => {
  const adminService = runtime.get(AdminService);
  const requireAdminAuth = makeRequireAdminAuth(runtime);
  const routes = new Hono();

  routes.post('/login', jsonBody(AdminLoginSchema), async (context) => {
    const input = context.req.valid('json');
    return success(context, await adminService.login(input));
  });

  // 登出幂等：token 有效则撤销会话，无效也返回成功（不要求登录态）
  routes.post('/logout', async (context) => {
    const token = extractToken(context);
    if (token) {
      return success(context, await adminService.logout({ token }));
    }
    return success(context, { success: true });
  });

  routes.use('*', requireAdminAuth);
  routes
    .post('/get-me', async (context) =>
      success(
        context,
        await adminService.getMe({ adminId: currentAdminId() }),
      ),
    )
    .post('/update-info', jsonBody(UpdateInfoSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await adminService.updateInfo({
          adminId: currentAdminId(),
          ...input,
        }),
      );
    })
    .post('/change-password', jsonBody(ChangePasswordSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await adminService.changePassword({
          adminId: currentAdminId(),
          ...input,
        }),
      );
    })
    .post('/create', jsonBody(CreateAdminSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await adminService.create(input));
    })
    .post('/page-query', jsonBody(PageQueryAdminDto), async (context) => {
      const input = context.req.valid('json');
      return success(context, await adminService.page(input));
    })
    .post('/detail', jsonBody(GetAdminDetailSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await adminService.get(input));
    })
    .post('/update', jsonBody(UpdateAdminSchema), async (context) => {
      const input = context.req.valid('json');
      return success(context, await adminService.update(input));
    })
    .post('/remove', jsonBody(RemoveAdminSchema), async (context) => {
      const input = context.req.valid('json');
      return success(
        context,
        await adminService.remove({
          ...input,
          operatorId: currentAdminId(),
        }),
      );
    })
    .post(
      '/reset-password',
      jsonBody(ResetAdminPasswordSchema),
      async (context) => {
        const input = context.req.valid('json');
        return success(context, await adminService.resetPassword(input));
      },
    );

  return routes;
};
