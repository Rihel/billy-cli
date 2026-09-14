import type {
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  QueryDeepPartialEntity,
  SelectQueryBuilder,
} from 'typeorm'
import _ from 'lodash'
import PQueue from 'p-queue'
import { BatchOperationError } from '../foundation/errors/infrastructure-errors.js'

/**
 * 批量操作的切片与并发参数。
 */
export interface BatchOptions {
  /** 每片条数，默认 100 */
  chunkSize?: number
  /** 最大并发片数，默认 5（事务内强制降为 1，见 {@link resolveBatchConcurrency}） */
  concurrency?: number
}

const defaultChunkSize = 100
const defaultConcurrency = 5

/**
 * 解析实际并发度。
 *
 * **铁律**：事务进行中必须串行 —— 事务内开并发会让多个 query 争用同一连接与事务快照，
 * 轻则连接池排队，重则死锁。故 `isTransactionActive` 时一律降为 1。
 */
export const resolveBatchConcurrency = (
  manager: EntityManager,
  concurrency = defaultConcurrency,
): number => (manager.queryRunner?.isTransactionActive ? 1 : concurrency)

/**
 * 分片并发执行骨架（并发度由调用方给定）。
 *
 * 任一分片失败不中断其余分片，全部结束后若有失败则聚合抛 {@link BatchOperationError}，
 * 保证「整体不静默成功」。
 */
async function runChunks<T>(
  items: T[],
  handler: (chunk: T[]) => Promise<unknown>,
  chunkSize: number,
  concurrency: number,
): Promise<void> {
  if (items.length === 0) return

  const queue = new PQueue({ concurrency })
  const failures: unknown[] = []

  for (const chunk of _.chunk(items, chunkSize)) {
    void queue.add(() => handler(chunk).catch((error) => failures.push(error)))
  }
  await queue.onIdle()

  if (failures.length > 0) {
    throw new BatchOperationError(failures.length, failures)
  }
}

/**
 * 通用分片处理：把 `items` 按 `chunkSize` 切片，以 `concurrency` 并发调用 `handler`。
 *
 * 删除 / 更新 / 查询 / 写入均可复用。需要感知事务串行语义时用下面的
 * `batchInsert` / `batchSave` / `batchUpsert`，它们会按 `manager` 的事务状态自动降并发。
 */
export async function batch<T>(
  items: T[],
  handler: (chunk: T[]) => Promise<unknown>,
  options: BatchOptions = {},
): Promise<void> {
  await runChunks(
    items,
    handler,
    options.chunkSize ?? defaultChunkSize,
    options.concurrency ?? defaultConcurrency,
  )
}

/**
 * 分片批量插入：每片一条 `INSERT ... VALUES (...)`。
 *
 * 不触发实体钩子、不级联保存关联关系，适合无关联的纯数据写入（导入 / 迁移）。
 * 注意：多对多中间表在 TypeORM 里不是实体，此方法对其无效。
 */
export async function batchInsert<T extends ObjectLiteral>(
  manager: EntityManager,
  entityType: EntityTarget<T>,
  data: QueryDeepPartialEntity<T>[],
  options: BatchOptions = {},
): Promise<void> {
  await runChunks(
    data,
    (chunk) =>
      manager
        .createQueryBuilder()
        .insert()
        .into(entityType)
        .values(chunk)
        .execute(),
    options.chunkSize ?? defaultChunkSize,
    resolveBatchConcurrency(manager, options.concurrency),
  )
}

/**
 * 分片批量 save：触发实体钩子、级联关联关系，适合有关联关系的写入。
 *
 * 代价：TypeORM 的 save 会对每条记录发 SELECT 判断 INSERT / UPDATE，
 * 大批量时明显慢于 {@link batchInsert}。
 */
export async function batchSave<T extends ObjectLiteral>(
  manager: EntityManager,
  data: T[],
  options: BatchOptions = {},
): Promise<void> {
  await runChunks(
    data,
    (chunk) => manager.save(chunk),
    options.chunkSize ?? defaultChunkSize,
    resolveBatchConcurrency(manager, options.concurrency),
  )
}

/**
 * 分片批量 upsert：每片一条 `INSERT ... ON CONFLICT DO UPDATE`。
 *
 * 适合数据导入 / 同步场景，无需预判记录是否存在。
 *
 * @param conflictPaths 冲突检测的唯一键字段，如 `['sku']` 或 `['tenantId', 'externalId']`
 */
export async function batchUpsert<T extends ObjectLiteral>(
  manager: EntityManager,
  entityType: EntityTarget<T>,
  data: QueryDeepPartialEntity<T>[],
  conflictPaths: string[],
  options: BatchOptions = {},
): Promise<void> {
  await runChunks(
    data,
    (chunk) => manager.upsert(entityType, chunk, conflictPaths),
    options.chunkSize ?? defaultChunkSize,
    resolveBatchConcurrency(manager, options.concurrency),
  )
}

/**
 * 批量删除选项。
 *
 * 两段式：先用 `selectIds` 选出**目标主键**，再按主键分片删除——
 * 直接对复杂 where 做分片删除不好切，先定主键再 `whereInIds` 最稳。
 */
export interface BatchDeleteOptions<T extends ObjectLiteral> {
  /** 构建「待删主键」查询（含全部 where / join 条件）；**只 select 主键列** */
  selectIds: () => SelectQueryBuilder<T>
  /** 主键列名，默认 `id`（复合主键请改用 `batch` 自行分片） */
  idCol?: string
  /** 每片条数，默认 100 */
  chunkSize?: number
  /** 最大并发片数，默认 5（事务内降为 1） */
  concurrency?: number
}

/**
 * 分片批量删除：先取目标主键，再按 `chunkSize` 分片 `DELETE ... WHERE id IN (...)`。
 *
 * 注意：本实现会把**全部目标主键一次性读进内存**（与 rihel-base 行为一致）。
 * 主键量极大（百万级）时显存吃紧，应改用 `pageWithDeferred` 思路边翻页边删。
 */
export async function batchDelete<T extends ObjectLiteral>(
  manager: EntityManager,
  entityType: EntityTarget<T>,
  options: BatchDeleteOptions<T>,
): Promise<void> {
  const { selectIds, idCol = 'id', chunkSize = defaultChunkSize } = options

  const rows = await selectIds().getRawMany<Record<string, unknown>>()
  if (rows.length === 0) return

  await runChunks(
    rows.map((row) => row[idCol]),
    (chunk) =>
      manager
        .createQueryBuilder()
        .delete()
        .from(entityType)
        .whereInIds(chunk)
        .execute(),
    chunkSize,
    resolveBatchConcurrency(manager, options.concurrency),
  )
}

