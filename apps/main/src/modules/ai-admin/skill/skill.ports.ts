/**
 * 技能变更通知端口（main → agent-runtime）。
 *
 * 迁移后 main 只写库，**不落盘、不加载 Mastra**；落盘与刷新由 agent-runtime 完成。
 * 两者之间的契约就是这条事件：
 * - `upsert`：库里的技能内容变了（新建 / 改元信息 / 写文件 / 导入 / 重新启用），
 *   runtime 收到后从 DB 读全量文件并 `sync` 到技能目录，然后 `loader.reload()`；
 * - `remove`：技能被删除或停用，runtime 删掉对应目录并 `loader.reload()`。
 *
 * 传输用 Redis Pub/Sub（kits 的 `EventBus`，topic `ai.skill.changed`），语义 at-most-once：
 * **不能替代 DB 一致性**。runtime 启动时会全量 `syncAll`，漏掉的事件由启动自愈兜底；
 * 事件里带 `version`，runtime 可用它判断「这条通知是不是已处理过」。
 *
 * 换成 Kafka 只需替换 `SkillChangeNotifier` 的实现，service 与接口不动。
 */

/** 变更种类：upsert = 写盘，remove = 删目录 */
export type SkillChangeAction = 'upsert' | 'remove'

/** 一次技能变更（跨进程契约，字段只增不改） */
export interface SkillChangeEvent {
  /** 技能名（= 落盘目录名） */
  skillKey: string
  action: SkillChangeAction
  /** 变更后的版本号（remove 时是删除前看到的版本） */
  version: number
  /** 变更后是否启用（remove 时为 false） */
  enabled: boolean
  /** 触发原因，仅用于排障 */
  reason:
    | 'create'
    | 'update'
    | 'file-save'
    | 'file-remove'
    | 'remove'
    | 'import-create'
    | 'import-update'
  /** 发布时刻（毫秒时间戳，发布方时钟） */
  at: number
}

/** 技能变更通知端口（service 只依赖这个接口，单测注入 fake） */
export interface SkillChangeNotifier {
  /**
   * 通知 runtime 刷新。
   *
   * @returns 是否成功广播（`false` = Redis 不可用 / 只送达本实例；**不阻断 DB 写入**）
   */
  notify(event: SkillChangeEvent): Promise<boolean>
}

/** 依赖注入 token（用 Symbol，避免与别处的同名接口冲突） */
export const SKILL_CHANGE_NOTIFIER = Symbol.for('AiSkillChangeNotifier')

/** 事件 topic（runtime 订阅同一个字符串） */
export const SKILL_CHANGE_TOPIC = 'ai.skill.changed'
