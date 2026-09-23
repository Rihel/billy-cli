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
  // 对外导出：AI agent 的工具经 TodoService 读写真实业务数据（见 modules/ai）
  exports: [TodoService],
})
export class TodoModule {}
