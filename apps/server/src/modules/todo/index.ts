import { Module } from '@nestjs/common';
import { TodoService } from './todo.service.js';
import { TodoRouter } from './todo.router.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';

@Module({
  providers: [TodoService, TodoRouter, AuthMiddleware],
})
export class TodoModule {}
