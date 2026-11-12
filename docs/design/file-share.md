# 文件免授权分享：`/s/{token}` 独立分享页

> 触发问题（2026-11-12）：文件列表页需要多一个「分享」操作 —— 点一下生成一条免授权的分享链接，
> **记录入库**、**可以设置有效期**；外部的人拿到链接，不登录就能直接预览。
> 同时**不能透露系统的任何信息**。
>
> 现状只能把对象存储地址发出去 —— 那等于把桶名、端点、`user/{userId}/{conversationId}`
> 全部交出去（见 §1.2）。本方案的目标是：**分享的是一个与内部无关的别名地址，而不是内部地址本身。**

## 0. 一句话

文件列表页点「分享」→ 落一行 `file_shares`（存 token 哈希 + 过期时间）→ 得到
`https://{share 域}/s/{token}`；浏览器只访问这个域，Next 页面负责渲染、Next route handler 负责把
字节流出去；server 只做两件很轻的事 —— **查 token、签发一次预签名 URL**。OSS 地址不进浏览器。

## 1. 现状与问题

### 1.1 现在分享一个文件有哪几条路

| 路 | 怎么做 | 问题 |
| --- | --- | --- |
| 发对象存储直链 | `formatStorageUrl(key)`（`apps/web/src/lib/constants.ts:54`） | 桶是 public-read，**永久有效且撤不回** |
| 发预签名 URL | `POST /storage/get-download-url`（`storage.controller.ts:58`） | 1 小时过期（`s3.ts:98`），且带凭证标识 |
| 让对方登录主站 | 走后台预览弹窗（`apps/admin/src/components/file-preview-dialog.tsx`） | 外部的人根本没有账号 |

三条都不满足「免授权 + 直接预览 + 不透露」。

### 1.2 直接发地址会泄露什么

| 发出的东西 | 实际暴露 | 依据 |
| --- | --- | --- |
| `{NEXT_PUBLIC_STORAGE_URL}/{key}` | 桶名、端点、存储厂商；key 里的 `user/{userId}/{conversationId}` | `ai-file-manager.md` §1.5、`constants.ts:42` |
| 预签名下载 URL | 上述全部 + 凭证标识（S3 `X-Amz-Credential`、COS `q-ak=<SecretId>`） | `providers/s3.ts:98`、`providers/cos.ts:78` |
| 主站接口 `/storage/*` | 域名、路由结构、`{code,message}` 信封与错误码字典 | `response-envelope.interceptor.ts:18` |
| 主站页面 | 登录 cookie、全站 bundle、埋点、路由 manifest | `apps/web/src/app/layout.tsx` |

### 1.3 「不透露系统信息」的验收口径

落成四类**可核对**的约束，实现完成后逐条验收（§7）：

1. **链接里看不出内部标识**：token 是纯随机串，不含文件 id、会话 id、用户 id；
2. **域名不指向业务系统**：分享域独立，页面与字节都在同一个中性域上；
3. **页面与响应头没有指纹**：无产品标题、无 API 域名、无框架头、无内部错误码；
4. **不可枚举、不可被搜索引擎收录**：token 熵足够 + `noindex`。

> 明确**不在**本轮范围：「连我们公司是谁都不能知道」。域名本身就是可注册信息，
> 真要彻底白标得换一个与产品无关的域名 —— 那是部署决策，不是代码决策。

## 2. 决策记录

| 议题 | 结论 | 理由 |
| --- | --- | --- |
| 链接形态 | `https://{share 域}/s/{token}` | 短、可转发、不出现任何内部路径 |
| 分享记录 | **入库** `file_shares` | 能设有效期、能撤销、能查「这个文件已经分享过几次」 |
| token 存明文吗 | **只存 SHA-256** | 库被拖走 ≠ 链接被拖走；明文只在创建响应里出现一次（代价见 §4.3） |
| 过期怎么判 | 存 `expires_at`，**状态靠派生** | 不起定时任务：`expired` 是「现在 > expires_at」，不是一列状态 |
| 字节从哪出去 | Next route handler 流式转发 | 不压业务进程；复用 `SERVER_URL`（服务端变量，不进 bundle） |
| 预签名 URL 谁能拿 | 只有 Next（内部密钥） | 公开接口返回 OSS 地址 = 换个地方泄露 |
| 分享页放哪 | `apps/web`，独立 root layout | 不新增部署；用 `(main)` 路由组隔开主站 Provider |
| 类型判定在哪 | server 算好 `previewKind` 下发 | 前端不猜扩展名，判据只有一份 |
| 分享的是快照还是当前文件 | **当前文件**（引用原 key） | 不复制对象、省存储；代价见 §8.4 |
| Next API 层 | **Hono**（`src/api/`），route 文件只做适配 | 中间件可组合；接口可脱离 Next 单元测试 |

## 3. 总体形态

### 3.1 URL

| 路径 | 处理方 | 返回 |
| --- | --- | --- |
| `/s/{token}` | Next 页面（server component） | HTML 预览页 |
| `/api/s/{token}/content` | Next API 层（Hono，`nodejs` runtime） | 文件字节，支持 Range |

同一个域、同一个源。页面里所有资源地址都是 `/api/s/{token}/content`，
**浏览器全程不会出现 server 域名和 OSS 域名**。

### 3.2 数据流

```
管理员 ──POST /share/create { fileId, expiresIn }──► server
                                                    └─ 写 file_shares（token_hash + expires_at）
                                                    ← { url: https://s.xxx/s/{token} }

浏览器 ──GET /s/{token}──────────────► Next 页面（服务端渲染）
                                     └─POST {SERVER_URL}/share/meta（token）
                                        ← { filename, mediaType, previewKind, bytes, expiresAt }

浏览器 ──GET /api/s/{token}/content──► Next API 层（Hono）
                                     ├─POST {SERVER_URL}/share/resolve（token + 内部密钥）
                                     │   ← { url(预签名, 300s), filename, mediaType }
                                     ├─GET {url}（透传 Range）
                                     └─200/206 + 流式 body
```

### 3.3 职责边界

| 谁 | 负责 | 不负责 |
| --- | --- | --- |
| server | token 校验、分享记录、`previewKind`、预签名签发 | 不碰字节、不渲染页面 |
| Next 页面 | 元信息 → 选择渲染器 → 渲染 | 不做鉴权、不猜类型 |
| Next content | 换签名、透传 Range、设置安全头 | 不缓存内容、不落盘 |
| 对象存储 | 存字节 | 不对公网暴露 |

## 4. 数据模型与 token

### 4.1 `file_shares` 表

`apps/server/src/database/entities/file-share-entity.ts`，继承 `BaseEntity`（`id` / 时间戳 / `deleted_at`）。
逻辑引用 `ai_files.id`，**不建物理外键**（全工程硬规则）。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `token_hash` | varchar(64) | `sha256(token)` 十六进制；**唯一索引** |
| `file_id` | varchar(20) | 指向 `ai_files.id` |
| `created_by` | varchar(20) nullable | 创建人（管理员 id）；鉴权关闭时为 null |
| `expires_at` | timestamp nullable | **null = 永久** |
| `revoked_at` | timestamp nullable | 撤销时间；非空即失效 |
| `views` | int default 0 | 被打开次数（meta 命中时自增） |
| `last_viewed_at` | timestamp nullable | 最后一次打开 |

索引：`uk_file_share_token(token_hash)` 唯一、`idx_file_share_file(file_id)`、
`idx_file_share_expires(expires_at)`（清理用，本轮不做清理任务）。

**不存 `status` 列**：状态由字段派生（§4.4），避免出现「状态说有效但早已过期」的二义性。

### 4.2 生成与存储

```ts
const token = randomBytes(24).toString('base64url')   // 32 字符、192 bit
const tokenHash = createHash('sha256').update(token).digest('hex')
```

- 查库走 `token_hash`（唯一索引），**明文不落库**；
- 创建响应里回一次明文 `token` 与完整 `url`，之后任何接口都不再返回它。

### 4.3 为什么只存哈希（以及它的代价）

存明文的后果：数据库被拖走 = 所有有效分享链接被拖走 = 文件被拖走。而哈希让拖库拿不到可用 token。

代价是**链接只在创建那一刻显示一次**，关掉弹窗后看不到了。三种处理：

| 做法 | 体验 | 安全 |
| --- | --- | --- |
| 只展示一次（**本轮选它**） | 关掉后再要就「重新生成」 | 最好 |
| 存明文，随时可复制 | 随时能复制 | 拖库即泄露 |
| 存密文（可解密） | 随时能复制 | 与明文差不多（同一把钥匙） |

列表页的分享弹窗里会列出「这个文件的历史分享」（有效期、状态、被看次数），
提供**重新生成**与**撤销**，弥补「看不到旧链接」这一点。

### 4.4 有效性判定（纯函数 + 一次查询）

```ts
type ShareState = 'active' | 'expired' | 'revoked' | 'invalid'

// invalid：token 查不到 / 文件已软删
// revoked：revoked_at 非空
// expired：expires_at 非空且已过
// active ：其余
```

判定顺序固定：**查不到 → invalid**；**已撤销 → revoked**；**已过期 → expired**；否则 active。
对外（`/s/*`）**一律折叠成 invalid** —— 不给「这个链接存在但过期了」这类 oracle。

不需要定时任务：过期不是一次写操作，而是一个比较。

## 5. 服务端接口

新增模块 `apps/server/src/modules/share/`，路由前缀 `/share`。
全部 POST + `@HttpCode(200)`（本工程业务路由约定）。

### 5.1 `POST /share/create` —— 生成分享链接

- 鉴权：`AnyAuthGuard`；管理员可分享任意文件，前台用户只能分享 `ai_files.user_id === 自己` 的行；
- 入参：`{ fileId: string, expiresIn?: number | null }`（秒；`null` / 省略 = 永久，默认 7 天）；
- 出参：

```ts
{
  id: string            // 分享记录 id，用于撤销
  token: string         // 只此一次
  url: string           // ${SHARE_PUBLIC_BASE_URL}/s/${token}
  expiresAt: number | null
}
```

- 校验：文件必须存在且未软删（`FileRepository.findById`，TypeORM 默认过滤软删行）；
- 同一文件允许多条有效分享（不同有效期 / 不同接收人各不相同），不合并。

### 5.2 `POST /share/list` —— 某个文件的分享记录

- 鉴权：`AnyAuthGuard`，权限同 5.1；
- 入参：`{ fileId: string }`；
- 出参：`{ items: Array<{ id, expiresAt, revokedAt, views, lastViewedAt, createdAt, state }> }`，
  **不含 token**（见 §4.3）；`state` 用 §4.4 的派生值。

### 5.3 `POST /share/revoke` —— 撤销

- 鉴权：`AnyAuthGuard`，只能撤自己创建的（管理员不限）；
- 入参：`{ id: string }`；
- 幂等：已撤销的再撤一次返回成功，不改 `revoked_at`。

### 5.4 `POST /share/meta` —— 页面拿元信息（公开）

- 鉴权：**公开**（Next 服务端渲染时调用），挂 `@RateLimit({ scope: 'share-meta', limit: 60 })`；
- 入参：`{ token }`；
- 出参：

```ts
{
  filename: string          // 展示名，不含路径
  mediaType: string         // 库里登记的类型，不是请求方给的
  previewKind: PreviewKind
  officeKind?: 'docx' | 'xlsx' | 'pptx'
  bytes: number
  expiresAt: number | null
}
```

- 副作用：`views + 1`、`last_viewed_at = now`（失败只记日志，**不影响响应**）；
- **绝不返回**：`key`、`fileId`、`conversationId`、`userId`、任何 URL。

### 5.5 `POST /share/resolve` —— 换预签名 URL（内部）

- 鉴权：请求头 `x-share-internal`，与 `SHARE_INTERNAL_SECRET` 定长比较（`timingSafeEqual`）；
  不匹配直接 404（不返回「密钥错误」，避免暴露端点存在）；
- 入参：`{ token }`；
- 出参：`{ url, filename, mediaType, bytes }`；
- 调用 `ObjectStorage.getDownloadUrl({ key, filename, expiresIn: 300 })`。

> `getDownloadUrl` 目前 S3 侧写死 3600（`s3.ts:98`），COS 侧没有显式 TTL、走 SDK 默认
> （`cos.ts:78`）。本轮把它提成可选入参 `expiresIn`：S3 缺省仍 3600（既有调用方行为不变），
> COS 显式沿用同一个值，两个 provider 的行为就此对齐。

### 5.6 配置

`apps/server/src/app-config.ts` 新增 `share` 命名空间（app 级，不进 kits）：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SHARE_PUBLIC_BASE_URL` | 无（缺省回落 `SERVER_PUBLIC_URL`） | 拼链接用，如 `https://s.example.com` |
| `SHARE_TTL_SECONDS` | 604800（7 天） | 创建时未指定过期时间的默认值 |
| `SHARE_INTERNAL_SECRET` | 无 | Next ↔ server 的内部密钥 |

分享能力**不依赖额外密钥**（token 是随机串 + 哈希），所以「没配也能用」；
只有 `SHARE_PUBLIC_BASE_URL` 缺失时 `create` 报「未配置分享域名」。

### 5.7 错误码

新增到 `AppErrorCodes`（3xxx 段）：

| code | 含义 | 对外表现 |
| --- | --- | --- |
| `SHARE_LINK_INVALID` | 查不到 / 已撤销 / 已过期 / 文件已删 | 中性文案，**不区分** |
| `SHARE_DISABLED` | 未配置分享域名 | 「分享能力未开启」 |

## 6. 前端

### 6.1 分享页路由与 layout

分享页要**完全脱离主站 shell**。当前 `apps/web/src/app/layout.tsx` 挂了
`ThemeProvider / QueryProvider / WebStorageProvider / Toaster`，其中
`WebStorageProvider` 会经 `useServerClient()` 把 `NEXT_PUBLIC_SERVER_URL` 带进客户端 bundle
（`apps/web/src/lib/constants.ts:40`）—— 这正是要避免的泄露。

改成多 root layout，主站页挪进 `(main)`：

```
apps/web/src/app/
  globals.css                    # 不动，两份 layout 都 import
  (main)/
    layout.tsx                   # 原 app/layout.tsx 原样迁入（含全站 Provider）
    page.tsx  account/  auth/  comparison/  markdown/
    error.tsx  loading.tsx  not-found.tsx
  (share)/
    layout.tsx                   # 只留 <html><body> + 字体，不挂任何 Provider
    s/[token]/page.tsx
  api/[[...route]]/route.ts      # Next API 层唯一入口（Hono，见 §6.3），与分享页同源
```

- `proxy.ts` 的 matcher 是 `/account/:path*`（`apps/web/src/proxy.ts:31`），不匹配 `/s/*`，不用改；
- `(share)/layout.tsx` 的 `metadata` 用中性标题（如「文件预览」），
  并设 `robots: { index: false, follow: false }`；
- 分享页**不引**会话、导航、toast、Query。

### 6.2 类型分发：`previewKind`

判据纯函数放 `packages/shared/src/utils/file-kind.ts`，
扩展名表从 `apps/server/src/modules/ai/core/tools/workspace.ts:129` 的 `TEXT_EXTENSIONS` 抽出来共用：

```ts
export type PreviewKind =
  | 'image' | 'video' | 'audio' | 'pdf' | 'text'
  | 'markdown' | 'html' | 'office' | 'none'

export const resolvePreviewKind = (input: {
  filename: string
  mediaType: string
}): { kind: PreviewKind; officeKind?: 'docx' | 'xlsx' | 'pptx' }
```

| kind | 判定 | 渲染 |
| --- | --- | --- |
| `image` | `image/*`（**不含 svg**） | `<img src="/api/s/{token}/content">` |
| `video` | `video/*` | `<video>`，需 Range |
| `audio` | `audio/*` | `<audio>`，需 Range |
| `pdf` | `application/pdf` | `<iframe>`，需 Range |
| `text` | `text/plain`、csv、json、代码 | `fetch → 文本`，上限 1MB |
| `markdown` | `text/markdown` / `.md` | 现有 Markdown 组件 |
| `html` | `text/html` / `.htm` | `SandboxFrame`（srcDoc 沙箱），**不 iframe 到 content** |
| `office` | docx / xlsx / xls / pptx | `fetch → ArrayBuffer → OfficePreview` |
| `none` | 其余（zip、老 doc/ppt、svg、未知） | 文件信息 + 下载 |

**判定规则**：登记的 `mediaType` 与扩展名冲突时取**更保守**的一边，拿不准一律 `none`。
宁可给下载，也不能把 HTML 塞进 iframe。

### 6.3 Next API 层：Hono，按官方 Next.js 集成方式

Next 侧的接口统一用 [Hono 官方的 Next.js 集成](https://hono.dev/docs/getting-started/nextjs)：
**一条 catch-all 路由文件 + `@hono/vercel` 的 `handle` + `basePath('/api')`**。

```
apps/web/src/app/api/[[...route]]/route.ts   # 入口：export const GET = handle(app) …
apps/web/src/api/app.ts                      # Hono 实例：basePath + 全局中间件 + 挂载能力
apps/web/src/api/share.ts                    # 分享能力路由（只声明自己的路径）
```

```ts
// app/api/[[...route]]/route.ts
import { handle } from '@hono/vercel'
import { app } from '@/api/app'

export const runtime = 'nodejs'        // 要透传大文件流 + 读运行时环境变量，Edge 不适合
export const dynamic = 'force-dynamic'

export const GET = handle(app)
export const HEAD = handle(app)
export const POST = handle(app)
// …其余方法按需补；路由写在 Hono 里，这个文件不用改
```

几点口径：

- **用 `@hono/vercel` 而不是 `hono/vercel`**：后者是随 Hono 分发的旧入口，已标记 deprecated（v5 移除）；
  前者是官方 starter 现在装的包，`handle` 就是 `(req) => app.fetch(req)`；
- **catch-all 只能放在 `/api` 下**：页面在 `/s/[token]`，若把 catch-all 也放在 `/s` 会与页面抢同一段动态路由；
- `basePath('/api')` 与全局中间件集中在 `api/app.ts`，能力模块只写自己的路径（`app.route('/s', shareRoutes)`）；
- 业务在 Hono 里，单测直接 `app.request(new Request(...))`，不用起 Next；
- 分享内容的最终地址是 `/api/s/{token}/content` —— 仍与页面同源，浏览器不会看到 server / OSS 域名。

```ts
// src/api/app.ts
export const app = new Hono().basePath('/api')

app.use('*', secureHeaders({
  referrerPolicy: 'no-referrer',
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'SAMEORIGIN',   // PDF 走同源 iframe，DENY 会连自己的预览框一起拦掉
  removePoweredBy: true,
}))

app.route('/s', shareRoutes)     // src/api/share.ts

// src/api/share.ts —— 只声明路径，不碰 basePath 与中间件
shareRoutes.on(['GET', 'HEAD'], '/:token/content', async (c) => {
  const resolved = await resolveShare(c.req.param('token'))   // 调 server /share/resolve
  if (!resolved) return new Response(null, { status: 404 })

  const range = c.req.header('range')
  const upstream = await fetch(resolved.url, {
    method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
    ...(range ? { headers: { range } } : {}),
    cache: 'no-store',
  })
  // 关键：直接透传 ReadableStream，绝不能 await arrayBuffer()
  return new Response(upstream.body, { status: upstream.status, headers: buildHeaders(resolved, upstream) })
})
```

`buildHeaders` 输出：

| 头 | 值 |
| --- | --- |
| `content-type` | `resolved.mediaType`（不信任对象元数据） |
| `content-length` / `content-range` / `accept-ranges` / `etag` | 透传上游 |
| `content-disposition` | 白名单类型 `inline; filename*=UTF-8''…`，其余 `attachment; …` |
| `x-content-type-options` | `nosniff` |
| `cache-control` | `private, max-age=300` |
| `x-robots-tag` | `noindex, nofollow` |

- 内联白名单只有：图片（**不含 svg**）、音视频、PDF、`text/plain`、`text/csv`；
- HTML / SVG / XML **一律 `attachment`**：即使有人直接打开 `/content`，也不会在分享域里执行脚本；
- `HEAD` 与 `GET` 走同一条路由（`on(['GET','HEAD'])`）：浏览器与 pdf.js 都会发 HEAD。

### 6.4 组件抽取（复用现有的全部预览能力）

「类型分发 + Office 渲染」现在在 admin 里（`file-preview-dialog.tsx:22` 的 `PreviewDialogItem`、
`apps/admin/src/components/office-preview.tsx`），`@repo/ui` 只有最底层的 `FilePreview`。
web 拿不到 admin 的代码，所以必须抽：

| 现在在哪 | 移到哪 | 说明 |
| --- | --- | --- |
| `OfficePreview` | `packages/ui/src/components/office-preview.tsx` | `docx-preview` / `xlsx` / `pptx-preview` 随迁到 `@repo/ui` 依赖；**保持动态 `import()`** |
| `PreviewDialogItem` 与分发判定 | `packages/ui/src/components/preview-item.ts` | admin 改为从 `@repo/ui` 引，行为不变 |

分享页只需要「单文件、无列表」形态，**不**复用 `FilePreviewDialog`（带清单、上下切换），
页面里直接 switch `previewKind`。

### 6.5 列表页的「分享」操作（本轮新增的入口）

位置：`apps/admin/src/app/main/ai/files/page.tsx` 的「操作」列（`columns` 第 210 行起），
在「预览 / 下载」后面加一个「分享」按钮。

```
点击「分享」
  └─ 打开 ShareDialog（ModalForm，弹窗不跳页）
        ├─ 有效期：1 小时 / 1 天 / 7 天 / 30 天 / 永久     （默认 7 天）
        ├─ [生成链接]
        ├─ 生成后：只读输入框 + 复制按钮（只此一次，见 §4.3）
        └─ 历史分享列表：状态 / 有效期 / 被看次数 / 撤销
```

要点：

- **弹窗里就能完成**，不新增页面、不跳路由；
- 生成成功后 `copyText` 写入剪贴板并 toast「链接已复制」（复用 `apps/admin/src/lib/clipboard.ts`）；
- 历史列表按 `createdAt` 倒序，`expired` / `revoked` 置灰 + 标签；
- 「撤销」二次确认，成功后刷新历史列表；
- 分享按钮的 `title` 提示「免授权链接，任何人拿到都能看」—— 避免误发。

## 7. 「不透露系统信息」验收清单

| # | 泄露面 | 措施 | 怎么验 |
| --- | --- | --- | --- |
| 1 | 链接内容 | 192 bit 随机 token，不含任何 id | 看链接即可；`token` 与 `fileId` 无关 |
| 2 | 域名 | 独立 share 域指向 web 部署 | 页面源码 / 打包产物里搜不到业务域 |
| 3 | 页面 shell | `(share)` 独立 root layout | 构建后 grep 分享页 chunk，无 `NEXT_PUBLIC_SERVER_URL` |
| 4 | 标题 / OG | 中性 metadata，`noindex` | `curl -s /s/x \| grep title` |
| 5 | 内部错误 | 页面只认「有效 / 无效」，不透传 code | 改坏 token，页面无数字 code |
| 6 | 文件地址 | 全部同源 `/api/s/{token}/content` | devtools 里无桶域名、无签名参数 |
| 7 | 响应头 | 网关剥 `Server` / `X-Request-Id` / `Vary`（Next 会给 route handler 自动加 `vary: rsc, next-router-state-tree…`，这是框架指纹，Hono 里删不掉，得在网关 `proxy_hide_header`） | `curl -I` |
| 8 | 搜索引擎 | `X-Robots-Tag: noindex` + 分享域 `robots.txt` 全禁 | `curl -I` |
| 9 | Referer 外泄 | `Referrer-Policy: no-referrer` | 页面里放外链看 Referer |
| 10 | 枚举 | 192 bit 随机 + 限流 | 连续错 token 触发 429 |

## 8. 安全与边界

### 8.1 XSS

- 分享域与主站**不同源**：cookie 天然隔离（主站 cookie 若设了 `Domain=.example.com`，
  分享子域属于同一父域，**必须**改成独立注册域，或主站 cookie 不设 `Domain`）；
- HTML 预览走 `SandboxFrame` 的 srcDoc，不加载真实 URL；
- `/content` 对 html/svg/xml 强制 `attachment`。

### 8.2 枚举与滥用

token 192 bit 随机，猜不出来；`meta` 走限流（默认 60 次/分/IP）。
同一文件允许多条分享，各自独立过期与撤销。

### 8.3 缓存

`/content` 用 `private, max-age=300`：浏览器内可拖动视频不回源，但**不进共享缓存**。
分享域前若挂 CDN，回源要带内部密钥，且不设 `s-maxage` —— 撤销依赖源站校验，
共享缓存会让失效延迟，本轮不引入。

### 8.4 快照 vs 当前文件

分享引用的是**原对象 key**，不是副本。后果：

| 场景 | 表现 |
| --- | --- |
| AI 用同名 `path` 覆盖提交 | 链接内容跟着变（`file-submit` 是覆盖语义） |
| 原文件被删（删会话 / 撤回） | 链接自动失效（`findById` 查不到软删行） |
| 想固定某一版 | 做不到，需要「分享即复制对象」（列入演进） |

对外话术要写清：**分享的是"这个文件"，不是"这一刻的副本"**。

### 8.5 既存风险：桶是 public-read

`providers/s3.ts:159` 的 `ensurePublicReadBucket` 把整个桶设成匿名可读，key 又是可推结构
（`user/{userId}/{md5}.png`）。也就是说**即使分享链路做对了，任何拿到原始 key 的人仍能绕过分享页
直连 OSS、且永久有效**。

本轮**不修**：web/admin 的图片展示（`formatStorageUrl`）直接依赖这个策略，收窄会打穿现有页面。
列为独立事项，方向是「展示改走签名 URL 或 CDN 回源，桶收回到私有」。
这一条必须在分享功能上线时**同步告知**，否则会误以为「分享 = 安全边界」。

## 9. 改动面

> **前置（已完成）**：`next` 16.4.5 → 16.4.6（web / admin 同步升级），两个 Next 应用都加 `hono@^4.13.18`
> 作为 API 层依赖；升级后 `typecheck` / `build` 通过。admin 目前没有 route handler，第一条接口出现时
> 按 §6.3 同一结构写（约定已写进 skill `develop-frontend-page`）。

| 层 | 文件 | 动作 |
| --- | --- | --- |
| shared | `src/schema/share.schema.ts` | 新增 DTO：create / list / revoke / meta / resolve |
| shared | `src/utils/file-kind.ts` | 新增 `resolvePreviewKind`，扩展名表从 `workspace.ts` 抽出 |
| shared | `src/dict/error-codes` | 新增 `SHARE_LINK_INVALID` / `SHARE_DISABLED` |
| kits | `src/storage/providers/*.ts`、`object-storage.ts` | `getDownloadUrl` 增加可选 `expiresIn` |
| server | `src/database/entities/file-share-entity.ts` | 新增实体 + 注册进 `root.module.ts` 的 `entities` |
| server | 迁移 | `db:gen` 生成 `file_shares` 迁移并执行 |
| server | `modules/share/{share.module,share.controller,share.service,share.repository,share.errors}.ts` | 新增模块 |
| server | `app-config.ts` | `share` 命名空间 + `mapServerEnv` 映射 |
| server | `root.module.ts` | 注册 `ShareModule` |
| server | `test/share.test.ts` | 状态派生 / 越权 / 撤销幂等 / 哈希校验 |
| sdk | `packages/sdk/src` | `client.share.create / list / revoke` |
| ui | `packages/ui/src/components/office-preview.tsx` | 从 admin 迁入（依赖随迁） |
| ui | `packages/ui/src/components/preview-item.ts` | 抽 `PreviewDialogItem` + 分发判定 |
| admin | `components/file-preview-dialog.tsx` | 改为从 `@repo/ui` 引 |
| admin | `components/share-dialog.tsx` | 新增：有效期选择 + 生成 + 复制 + 历史 + 撤销 |
| admin | `app/main/ai/files/page.tsx` | 操作列加「分享」 |
| web | `src/api/app.ts` | 新增 Hono 入口（`basePath(/api)` + 安全头 + 挂载），已落地 |
| web | `src/api/share.ts` | 新增分享路由（content 转发），已落地 |
| web | `app/api/[[...route]]/route.ts` | 新增 catch-all 入口（`handle(app)`），已落地 |
| web | `app/(main)/*` | 现有页面迁入路由组（机械改动） |
| web | `app/(share)/layout.tsx`、`s/[token]/page.tsx`、`s/[token]/content/route.ts` | 新增 |
| 部署 | ingress | `s.example.com` → web 服务 |

## 10. 验证

### 10.1 单测

`apps/server/test/share.test.ts`：

1. 状态派生：`active` / `expired`（`expires_at` 过去）/ `revoked`（`revoked_at` 非空）/
   `invalid`（查不到、文件软删）；
2. `revoke` 幂等：撤两次，`revoked_at` 不变；
3. 有效期内 meta 命中 → `views + 1`；
4. 越权：前台用户分享他人文件 → 403；
5. token 哈希：同 token 两次查询命中同一行；改一位查不到。

`file-kind`：每种扩展名 / MIME 组合的 kind 断言；**冲突时取保守结果**。

### 10.2 链路自测

| 步骤 | 期望 |
| --- | --- |
| 文件页点「分享」→ 选 7 天 → 生成 | 返回链接并复制成功 |
| 无痕窗口打开链接 | 图片/Office 正常预览，无登录、无导航 |
| devtools 看请求 | 只有分享域，无桶域名、无 `X-Amz-*` |
| 再次打开分享弹窗 | 历史列表有一条，状态「有效」，被看次数 +1 |
| 点「撤销」 | 链接立即失效，页面显示中性「链接已失效」 |
| 设 10 秒有效期，等过期 | 同上（不区分过期与撤销） |
| 改 token 一个字符 | 同上，无错误码 |
| 分享 zip / 老 doc | 文件信息 + 下载 |
| 分享 html | 沙箱渲染；直接打开 `/content` 是下载 |
| 分享 mp4 | 可拖进度条（看 206） |

### 10.3 泄漏检查（手工）

```bash
curl -sI "https://s.example.com/s/$TOKEN"        # 无 Server / X-Powered-By / X-Request-Id
curl -s  "https://s.example.com/s/$TOKEN" | grep -E "<title>|NEXT_PUBLIC|localhost:9989"
curl -sI "https://s.example.com/s/$TOKEN/content" | grep -E "content-type|robots|referrer"
```

## 11. 演进（本轮不做）

1. **访问密码**：`password_hash` 一列 + 一个输入页，复用现有密码散列；
2. **下载次数上限 / 水印**：`max_views` + 服务端重编码，成本高，按需；
3. **分享即复制**：创建时 `CopyObject` 到 `share/{id}/…`，得到真正快照，撤销 = 删对象；
4. **过期清理任务**：`idx_file_share_expires` 已有，接 `Scheduler` 定期删过期行；
5. **大文件直传 CDN**：分享域前挂 CDN 回源到 content 路由，`resolveUrl` 不用改；
6. **多资源分享**：目前只支持 `ai_files`，泛化需把 `file_id` 换成 `{type, id}`。

## 12. 待定

| # | 问题 | 影响 |
| --- | --- | --- |
| 1 | 有效期预设档位是否就这五档（1h / 1d / 7d / 30d / 永久）？ | 只影响弹窗，接口收秒数 |
| 2 | 「链接只显示一次」能否接受？不接受就要改存明文（§4.3） | 决定表结构与安全口径 |
| 3 | 分享域是否使用独立注册域？ | 决定主站 cookie 要不要改 `Domain` |
| 4 | 是否需要「分享」入口同时加到聊天右栏文件树？ | 复用同一个弹窗，成本很低 |
