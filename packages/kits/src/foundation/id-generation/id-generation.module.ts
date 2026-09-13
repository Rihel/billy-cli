import { Global, Module } from '@nestjs/common'
import { IdGeneration } from './id-generation.js'

/** 基础能力：ID 生成（无配置） */
@Global()
@Module({ providers: [IdGeneration], exports: [IdGeneration] })
export class IdGenerationModule {}
