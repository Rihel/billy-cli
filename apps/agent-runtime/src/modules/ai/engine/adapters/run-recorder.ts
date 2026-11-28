import { Inject, Injectable } from '@nestjs/common'
import { ToolCallMetaStore } from '../../tools/engine/tool.meta.js'
import { StreamRecorder } from '../../runtime/stream/stream-recorder.js'
import { TimelineRepository } from '../../runtime/run/timeline.repository.js'
import type { RunRecorder, RunRecorderFactory } from '../ports.js'

/** 录制器工厂：一次 run 一个，绑定归属上下文与工具审计旁证 */
@Injectable()
export class StreamRecorderFactory implements RunRecorderFactory {
  constructor(
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(ToolCallMetaStore) private readonly metas: ToolCallMetaStore,
  ) {}

  create(context: {
    conversationId: string
    runId: string
    isKnownTool?: (key: string) => boolean
  }): RunRecorder {
    return new StreamRecorder(
      this.timelines,
      { conversationId: context.conversationId, runId: context.runId },
      {
        metas: this.metas,
        ...(context.isKnownTool ? { isKnownTool: context.isKnownTool } : {}),
      },
    )
  }
}
