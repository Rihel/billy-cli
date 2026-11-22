import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { defaultDenyPaths } from '@repo/kits'

/**
 * local 后端的根目录解析：**平台托管目录** vs **宿主目录**。
 *
 * 两种形态的差别（见 `docs/design/workspace.md` §3.1.1）：
 *
 * | | 平台托管（默认） | 宿主目录（填了 `location.root`） |
 * | --- | --- | --- |
 * | 根 | `<WORKSPACE_LOCAL_ROOT>/<workspaceId>` | 用户给的绝对路径（realpath 后） |
 * | 初始化 | 跑（装 CLI / 物化技能 / 落凭据） | **不跑**：不能往用户自己的项目里写 `.billy/`、`.agents/` |
 * | 校验 | 无 | 必须是已存在目录，且落在 `WORKSPACE_LOCAL_ALLOWED_ROOTS` 之内 |
 *
 * 为什么要有允许根：`local` 后端的命令与文件读写都发生在**宿主机**上，文件能力（`localFs`）
 * 甚至不经沙箱、直接以服务进程身份读写。允许任意路径等于把整台宿主交给工作区，
 * 所以默认**关闭**（没配允许根就拒绝自定义宿主目录），而不是给个「方便」的默认放行。
 */

export type HostRootReason =
  | 'not-absolute'
  | 'too-broad'
  | 'missing'
  | 'not-directory'
  | 'outside-allowed'
  | 'covers-credentials'
  | 'unsandboxed'

/** 宿主目录不可用：`reason` 给调用方分支，`message` 直接给用户看（中文） */
export class HostRootError extends Error {
  constructor(
    readonly reason: HostRootReason,
    message: string,
  ) {
    super(message)
    this.name = 'HostRootError'
  }
}

/** `target` 是否等于 `root` 或位于 `root` 之下（纯字符串判断，入参须已是绝对路径） */
export const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** realpath 失败（路径不存在 / 无权限）时退回字面路径，用于比较而不是信任 */
const realOrSelf = async (path: string): Promise<string> => realpath(path).catch(() => path)

export interface LocalRootInput {
  /** 平台托管根（`WORKSPACE_LOCAL_ROOT`） */
  localRoot: string
  workspaceId: string
  /** 工作区配置里的 `location.root`（宿主目录，绝对路径） */
  requested?: string | null
  /** `WORKSPACE_LOCAL_ALLOWED_ROOTS`：允许被指定为宿主目录的根 */
  allowedRoots: string[]
  /** 禁读目录（默认取 kits 的凭据 denylist，测试可注入） */
  denyPaths?: string[]
}

export interface LocalRootPlan {
  /** 归一后的绝对路径（realpath 之后） */
  root: string
  /** true = 平台托管（要跑初始化）；false = 宿主目录（跳过初始化） */
  managed: boolean
}

/**
 * 解析 local 后端的根目录。
 *
 * 平台托管分支只拼路径（建目录由调用方做，保持与旧行为一致）；
 * 宿主目录分支要过五道闸：绝对路径 → 不是 `/` → 存在且是目录 → 在允许根之内 → 不覆盖凭据目录。
 */
export const resolveLocalRoot = async (input: LocalRootInput): Promise<LocalRootPlan> => {
  const requested = input.requested?.trim()
  if (!requested) return { root: resolve(input.localRoot, input.workspaceId), managed: true }

  if (!isAbsolute(requested)) {
    throw new HostRootError(
      'not-absolute',
      `文件夹要填完整路径（如 /Users/you/code），当前是：${requested}`,
    )
  }
  const literal = resolve(requested)
  if (literal === '/') {
    throw new HostRootError('too-broad', '不能把整个磁盘根目录当作工作区')
  }

  const allowed = await Promise.all(input.allowedRoots.map((dir) => realOrSelf(resolve(dir))))
  if (allowed.length === 0) {
    throw new HostRootError(
      'outside-allowed',
      '暂不支持指定文件夹：部署侧需要配置 WORKSPACE_LOCAL_ALLOWED_ROOTS（允许作为工作区的目录）',
    )
  }

  const canonical = await realpath(literal).catch(() => null)
  if (!canonical) throw new HostRootError('missing', `文件夹不存在：${literal}`)
  const info = await stat(canonical).catch(() => null)
  if (!info?.isDirectory())
    throw new HostRootError('not-directory', `这个路径不是文件夹：${canonical}`)

  if (!allowed.some((dir) => isInside(dir, canonical))) {
    throw new HostRootError(
      'outside-allowed',
      `文件夹不在允许的范围内：${canonical}（允许：${allowed.join('、')}）`,
    )
  }

  const denyPaths = input.denyPaths ?? defaultDenyPaths()
  for (const deny of denyPaths) {
    const real = await realOrSelf(deny)
    if (isInside(canonical, real)) {
      throw new HostRootError(
        'covers-credentials',
        `宿主目录过宽：包含凭据目录 ${deny}，请改指更具体的项目目录`,
      )
    }
  }

  return { root: canonical, managed: false }
}
