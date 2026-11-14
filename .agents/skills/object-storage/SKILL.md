---
name: object-storage
description: 在 Billy 工程中使用对象存储与文件上传下载：S3/COS 统一入口（ObjectStorage）、预签名 URL、STS 临时凭证、前端 FileUpload / ImageUpload / useStorage 上传链路、文件 key 约定与展示。触发词：存储、上传、下载、文件、图片、对象存储、S3、COS、预签名、STS、FileUpload、ImageUpload。
---

# 对象存储与文件上传下载

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——文件读写**先复用 `ObjectStorage` 统一入口 /
`@repo/ui` 组件 / `client.storage` SDK**，不自己调 S3 SDK）。

## 核心要点

- 后端统一入口 `ObjectStorage`（S3 / COS 双 provider）：`getPresignedUrl` / `getDownloadUrl` /
  `getTemporaryCredentials` / `getObject` / `removeObject`，位于
  `kits/src/storage/`（`ObjectStorageModule` 装配）。
- 路由 `/storage/*`（`modules/storage/storage.controller.ts`，三个端点，`@UseGuards(AnyAuthGuard)` **前台用户或管理员**），SDK `client.storage.*`。
- **key 命名空间（安全要点）**：前台用户的 key 由服务端**强制改写**进 `user/{userId}/`（上传）或**必须落在该前缀内**（下载，越界 403）；管理员与鉴权关闭时 key 原样。
  **STS 临时凭证仍仅限管理员**（`AssumeRole` 给的是整桶权限，与前缀约束不是一回事）。详见
  `docs/design/storage-access-policy.md` 与 `modules/storage/storage-key.ts`。
- **上传走预签名直传**：前端 `useStorage` 用 `key = md5+ext` 拿预签名 URL → `PUT` 直传，
  业务只存 `key`，不存完整 URL。
- **桶默认私有（2026-11-14 起）**：不再有公开读策略；展示 / 下载一律用
  `client.storage.getDownloadUrl({ key })` 拿短时预签名 URL（组件侧用 `useStorageUrl`）。
  `formatStorageUrl(key)` 拼的公开地址**只对绝对 URL 兼容有效**，不能用于对象 key。
- 组件：`FileUpload` / `ImageUpload` / `FilePreview` / `SortableFileList`（`@repo/ui`）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/storage-guide.md](./references/storage-guide.md) | 统一入口方法、配置、路由、SDK、前端上传下载链路、key 约定、STS | 做文件上传 / 下载 / 存储时（必读） |

## 完成检查清单

- [ ] 上传走预签名直传（`useStorage` + `ObjectStorage` 统一入口），未自写 S3 SDK / 大文件过服务端
- [ ] 业务只存 `key`（md5+ext），不存完整 URL；展示用 `formatStorageUrl`
- [ ] 路由复用 `/storage/*` 与 `client.storage.*`，未重复造端点
- [ ] 新文件字段（如 avatar / 附件）已在 schema / 实体 / 表单三处一致接入
- [ ] 配置走 `OBJECT_STORAGE_*` 环境变量，未硬编码桶 / 密钥
- [ ] 新增存储路由时：鉴权用 `AnyAuthGuard`，**前台侧 key 必须经 `storage-key.ts` 的 `resolveUploadKey` / `assertDownloadKey` 收敛**（别直接信任客户端传的 key）
