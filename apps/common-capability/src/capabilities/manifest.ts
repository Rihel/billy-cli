import { defineCapability, defineService } from '@repo/capability'
import {
  AppendFileInputSchema,
  BashParams,
  DownloadInputSchema,
  FileSearchInputSchema,
  ListInputSchema,
  MemoryForgetInputSchema,
  MemorySaveInputSchema,
  MemorySearchInputSchema,
  ReadFileInputSchema,
  ReadToolResultParams,
  ReplaceFileInputSchema,
  SubmitInputSchema,
  WebFetchParams,
  WebRequestParams,
  WebSearchParams,
  WorkspaceFilesInputSchema,
  WriteFileInputSchema,
} from './schemas.js'

export const execService = defineService({
  service: 'exec',
  title: '通用能力',
  owner: '平台组',
  capabilities: [
    defineCapability({
      tool: 'bash',
      title: '执行 bash 命令',
      description:
        '在沙箱里执行一条命令，返回退出码、stdout 与 stderr。命令要幂等，输出尽量用管道收窄。',
      input: BashParams,
      risk: 'write',
      timeoutMs: 300_000,
      execution: {
        mode: 'task',
        owner: 'session',
        yieldMs: 45_000,
        wait: { maxWaitMs: 60_000 },
        cancel: 'supported',
        maxRunMs: 1_800_000,
      },
    }),
  ],
})

export const webService = defineService({
  service: 'web',
  title: '网页能力',
  owner: '平台组',
  capabilities: [
    defineCapability({
      tool: 'web-fetch',
      title: '抓取网页',
      description: '抓取网页并转成 Markdown，按页返回；续页用 ref + page。',
      input: WebFetchParams,
    }),
    defineCapability({
      tool: 'web-search',
      title: '搜索网页',
      description: '按关键词搜索网页，返回标题、链接与摘要；需要正文时置 needContent。',
      input: WebSearchParams,
    }),
    defineCapability({
      tool: 'web-request',
      title: '请求 HTTP 接口',
      description: '直接发一个 HTTP 请求，用于 JSON 接口、需要 POST 或自定义头的场景。',
      input: WebRequestParams,
      risk: 'write',
    }),
  ],
})

export const filesService = defineService({
  service: 'files',
  title: '文件能力',
  owner: '平台组',
  capabilities: [
    defineCapability({
      tool: 'file-list',
      title: '列文件',
      description: '列出会话工作区里的文件',
      input: ListInputSchema,
    }),
    defineCapability({
      tool: 'read-file',
      title: '读文件',
      description: '读工作区里的文本文件',
      input: ReadFileInputSchema,
    }),
    defineCapability({
      tool: 'write-file',
      title: '写文件',
      description: '整文件覆盖写入',
      input: WriteFileInputSchema,
      risk: 'write',
    }),
    defineCapability({
      tool: 'append-file',
      title: '追加文件',
      description: '把内容追加到文件末尾',
      input: AppendFileInputSchema,
      risk: 'write',
    }),
    defineCapability({
      tool: 'replace-file',
      title: '替换片段',
      description: '替换文件里的指定片段',
      input: ReplaceFileInputSchema,
      risk: 'write',
    }),
    defineCapability({
      tool: 'file-search',
      title: '搜文件内容',
      description: '按关键字搜索工作区文件内容',
      input: FileSearchInputSchema,
    }),
    defineCapability({
      tool: 'file-submit',
      title: '提交文件',
      description: '把文件提交到对象存储',
      input: SubmitInputSchema,
      risk: 'write',
    }),
    defineCapability({
      tool: 'file-download',
      title: '下载文件',
      description: '把对象存储里的文件拉到工作区',
      input: DownloadInputSchema,
      risk: 'write',
    }),
    defineCapability({
      tool: 'workspace-files',
      title: '工作区清单',
      description: '列出对象存储里的工作区文件',
      input: WorkspaceFilesInputSchema,
    }),
    defineCapability({
      tool: 'read-tool-result',
      title: '取工具结果下一页',
      description: '按句柄取分页结果',
      input: ReadToolResultParams,
    }),
  ],
})

export const memoryService = defineService({
  service: 'memory',
  title: '记忆能力',
  owner: '平台组',
  capabilities: [
    defineCapability({
      tool: 'memory-save',
      title: '保存记忆',
      description: '保存一条长期记忆',
      input: MemorySaveInputSchema,
      risk: 'write',
    }),
    defineCapability({
      tool: 'memory-search',
      title: '搜索记忆',
      description: '按语义搜索长期记忆',
      input: MemorySearchInputSchema,
    }),
    defineCapability({
      tool: 'memory-forget',
      title: '删除记忆',
      description: '删掉一条长期记忆',
      input: MemoryForgetInputSchema,
      risk: 'write',
    }),
  ],
})

export const SERVICE_DEFINITIONS = [execService, webService, filesService, memoryService]
