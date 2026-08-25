# 对象存储与文件详解（object-storage 引用文件）

> 本文件是 `object-storage` skill 的组成部分，由主 SKILL.md 引用。
> 使用对象存储 / 实现文件上传下载时必读。

## 1. 后端门面（core/infrastructure/object-storage）

`ObjectStorage` 门面（`packages/core/src/infrastructure/object-storage/object-storage.ts`），
支持 **S3 / COS** 双 provider，公共方法：

- `getPresignedUrl(dto)` → 上传预签名 URL（`StoragePresignedUrlModel`）
- `getDownloadUrl(key)` → 下载预签名 URL
- `getTemporaryCredentials(dto)` → STS 临时凭证（客户端直传场景）
- `getObject(key)` / `removeObject(key)` → 服务端读取 / 删除（内部用，不暴露 API）

注入方式：`runtime.get(ObjectStorage)`（生命周期组件，`addLifeCycleService` 注册）。

## 2. 配置（apps/server/.env）

```env
OBJECT_STORAGE_PROVIDER=s3        # 或 cos
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=billy-cli
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
OBJECT_STORAGE_ENDPOINT=http://localhost:9000   # MinIO 本地
```

未配置时用默认值；`docker compose up minio` 可起本地 MinIO 联调。

## 3. 路由（apps/server/src/features/storage.ts，均已 requireAuth）

| 端点 | 入参 schema | 说明 |
| --- | --- | --- |
| `/storage/get-presigned-url` | `GetStorageUploadPresignedUrlSchema` | 上传预签名 |
| `/storage/get-download-url` | `GetStorageDownloadUrlSchema` | 下载预签名 |
| `/storage/get-temporary-credentials` | 无入参（取 `requestContext.userId`） | STS 临时凭证 |

## 4. SDK

`packages/sdk/src/server.client.ts` 的 `storage` 段：
`getPresignedUrl` / `getDownloadUrl` / `getTemporaryCredentials`。

## 5. 前端上传 / 下载链路（关键）

### 上传（走预签名直传，不经服务端中转）

核心 hook `useStorage`（`packages/aui/src/components/storage/useStorage.ts`）：

```ts
const { getPresignedUpload } = useStorageAdapter()
const key = `${fileInfo.md5}${fileInfo.ext ?? ''}`   // key 约定：md5+扩展名
const presigned = await getPresignedUpload(key)       // 拿预签名 URL
await fetch(presigned.url, { method: 'PUT', body: file, ... })  // 直传
```

- `key` 由前端计算（`getFileInfo` 得 md5 + ext），**内容寻址**：同一文件上传不重复占空间。
- 上传成功后把 `key` 存入业务字段（如 avatar），**不存完整 URL**。

### 展示 / 下载

- 展示：`formatStorageUrl(key)`（`@/lib/constants`，拼 `NEXT_PUBLIC_STORAGE_URL`）。
- 下载：`client.storage.getDownloadUrl({ key })` 拿预签名 URL。

## 6. 前端组件（@repo/aui，storage 目录）

- `StorageProvider`：全局提供 `useStorageAdapter()`（读 SDK 的 storage 段）。
- `useStorage`：上传核心 hook（customRequest / uploadFile / fileItems）。
- `ImageUpload` / `FileUpload` / `FilePreview` / `SortableFileList`：图片 / 文件选择、预览、排序列表。
- `formatStorageUrl`：key → 可访问 URL。

## 7. 关键约定与注意

- **key 用 md5+ext**：内容寻址、天然去重，但同名覆盖/业务可读性弱；需可读 key 时自行扩展前缀。
- **业务只存 key，不存完整 URL**：URL 会过期 / 更换域名，key 才是稳定标识。
- **上传不经服务端**：用预签名 URL 直传，避免大文件占服务端带宽与内存。
- **STS 场景**：需要客户端直接写桶（非浏览器 PUT 预签名）时用 `getTemporaryCredentials`。
- 新接口涉及文件读写时，先按「实现查找顺序」确认用上述门面 / SDK，不要自写 S3 SDK 调用。
