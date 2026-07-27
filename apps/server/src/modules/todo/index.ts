import { Module } from '@nestjs/common';
import { TodoService } from './todo.service.js';
import { TodoController } from './todo.controller.js';

@Module({
  controllers: [TodoController],
  providers: [TodoService],
  exports: [TodoService],
})
export class TodoModule {}
