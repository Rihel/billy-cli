import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { TRPCModule } from 'nestjs-trpc';
import { InfraModule } from './infra/infra.module.js';
import { TodoModule } from './modules/todo/index.js';
import { AuthModule } from './modules/auth/index.js';
import { UserModule } from './modules/user/index.js';
import { TrpcAppContext } from './trpc.context.js';
import { AuthMiddleware } from './middlewares/auth.middleware.js';
import { TrpcStatusMiddleware } from './middlewares/trpc-status.middleware.js';
import { AppError } from './errors.js';

@Module({
  imports: [
    InfraModule,
    TRPCModule.forRoot({
      basePath: '/trpc',
      context: TrpcAppContext,
      errorFormatter: ({ error, shape }) => ({
        ...shape,
        data: {
          ...shape.data,
          errorCode: error instanceof AppError ? error.errorCode : null,
        },
      }),
    }),
    TodoModule,
    AuthModule,
    UserModule,
  ],
  providers: [TrpcAppContext, AuthMiddleware],
})
export class RootModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TrpcStatusMiddleware)
      .forRoutes({ path: 'trpc/*path', method: RequestMethod.ALL });
  }
}
