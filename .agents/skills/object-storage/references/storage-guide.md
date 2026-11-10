# 对象存储与文件详解（object-storage 引用文件）

> 本文件是 `object-storage` skill 的组成部分，由主 SKILL.md 引用。
> 使用对象存储 / 实现文件上传下载时必读。

## 1. 后端统一入口（kits/src/storage）

`ObjectStorage` 统一入口（`packages/kits/src/storage/object-storage.ts`），
支持 **S3 / COS** 双 provider，公共方法：

- `getPresignedUrl(dto)` → 上传预签名 URL（`StoragePresignedUrlModel`）
- `getDownloadUrl(key)` → 下载预签名 URL
- `getTemporaryCredentials(dto)` → STS 临时凭证（客户端直传场景）
- `getObject(key)` / `removeObject(key)` → 服务端读取 / 删除（内部用，不暴露 API）

注入方式：构造器 `@Inject(ObjectStorage)`（由 `ObjectStorageModule.forRoot({ provider, region,
bucket, accessKeyId, secretAccessKey, endpoint })` 装配；运行时另注入 `RedisModule` 提供的
`RedisStore` 做预签名缓存——两者都是 `@Global()` 模块，一并 import 进 `root.module.ts` 即可，
DI 解析不依赖 `imports` 的先后顺序）。

## 2. 配置（apps/server/.env）

```env
OBJECT_STORAGE_PROVIDER=s3        # 或 cos
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=billy-cli
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
OBJECT_STORAGE_ENDPOINT=http://localhost:9000   # MinIO 本地
```

`OBJECT_STORAGE_ENDPOINT` **没有默认值**（2026-11-11 起）：
- 不配 = 对象存储未启用，服务照常启动；上传 / 下载 / 附件等真正用到存储的调用才报
  「对象存储未配置或不可用」；
- 配了但 MinIO / S3 不可达：启动只记 `storage.init_failed` 警告，不拦启动；首次使用会重试初始化。

`docker compose up minio` 可起本地 MinIO 联调（compose 映射宿主 19000，故本地
`OBJECT_STORAGE_ENDPOINT=http://localhost:19000`）。

## 3. 路由（apps/server/src/modules/storage/storage.controller.ts：`@Controller('storage')` +
`@UseGuards(AnyAuthGuard)`（前台用户或管理员），均 `@HttpCode(200)`）

| 端点 | 入参 schema | 前台用户 | 管理员 |
| --- | --- | --- | --- |
| `/storage/get-presigned-url` | `GetStorageUploadPresignedUrlSchema` | key 被**改写**为 `user/{userId}/{basename}` | key 原样 |
| `/storage/get-download-url` | `GetStorageDownloadUrlSchema` | 仅限 `user/{userId}/` 前缀，越界 **403** | key 原样 |
| `/storage/get-temporary-credentials` | 无入参 | **拒绝（403）**，仅管理员 | `AssumeRole` 临时凭证 |

key 收敛是纯函数（`modules/storage/storage-key.ts`，可单测）：只取最后一段 + 白名单字符，
杜绝目录穿越与伪造他人前缀；身份从 `requestContext` 读（双身份下必有一个缺失，
**不要**用会抛错的 `currentUserId()` / `currentAdminId()`）。设计说明见
`docs/design/storage-access-policy.md`。

## 4. SDK

`packages/sdk/src/server.client.ts` 的 `storage` 段：
`getPresignedUrl` / `getDownloadUrl` / `getTemporaryCredentials`。

## 5. 前端上传 / 下载链路（关键）

### 上传（走预签名直传，不经服务端中转）

核心 hook `useStorage`（`packages/ui/src/components/use-storage.ts`）：

```ts
const { getPresignedUpload } = useStorageAdapter()
const key = `${fileInfo.md5}${fileInfo.ext ?? ''}`   // key 约定：md5+扩展名
const presigned = await getPresignedUpload(key)       // 拿预签名 URL
await fetch(presigned.url, { method: 'PUT', body: file, ... })  // 直传
```

- `key` 由前端计算（`getFileInfo` 得 md5 + ext），**内容寻址**：同一文件上传不重复占空间。
- **必须用响应里的 `presigned.key` 落库**（而不是本地算出的 key）：前台用户的 key 由服务端
  加上 `user/{userId}/` 前缀后回传（`useStorage` 已如此实现），用本地 key 会指向不存在的对象。
- 上传成功后把 `key` 存入业务字段（如 avatar），**不存完整 URL**。

### 展示 / 下载

- 展示：`formatStorageUrl(key)`（`@/lib/constants`，拼 `NEXT_PUBLIC_STORAGE_URL`）。
- 下载：`client.storage.getDownloadUrl({ key })` 拿预签名 URL。

## 6. 前端组件（@repo/ui）

- `StorageProvider`：全局提供 `useStorageAdapter()`（读 SDK 的 storage 段）。
- `useStorage`：上传核心 hook（`uploadFile` / `fileItems`，md5 去重 key + 预签名直传）。
- `ImageUpload` / `FileUpload` / `FilePreview` / `SortableFileList`：图片 / 文件选择、预览、排序列表。
- `formatStorageUrl`：key → 可访问 URL。

## 7. 关键约定与注意

- **key 用 md5+ext**：内容寻址、天然去重，但同名覆盖/业务可读性弱；需可读 key 时自行扩展前缀。
- **业务只存 key，不存完整 URL**：URL 会过期 / 更换域名，key 才是稳定标识。
- **上传不经服务端**：用预签名 URL 直传，避免大文件占服务端带宽与内存。
- **STS 场景**：需要客户端直接写桶（非浏览器 PUT 预签名）时用 `getTemporaryCredentials`。
- 新接口涉及文件读写时，先按「实现查找顺序」确认用上述统一入口 / SDK，不要自写 S3 SDK 调用。
