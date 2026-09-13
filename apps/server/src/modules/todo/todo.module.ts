import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { TodoController } from './todo.controller.js'
import { TodoRepository } from './todo.repository.js'
import { TodoService } from './todo.service.js'

/** 待办模块（全链路示例模块：契约 / 实体 / repository / service / 路由） */
@Module({
  imports: [AdminModule],
  controllers: [TodoController],
  providers: [TodoRepository, TodoService],
})
export class TodoModule {}
