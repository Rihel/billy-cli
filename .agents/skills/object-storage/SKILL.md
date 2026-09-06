---
name: object-storage
description: 在 Billy 工程中使用对象存储与文件上传下载：S3/COS 门面（ObjectStorage）、预签名 URL、STS 临时凭证、前端 FileUpload / ImageUpload / useStorage 上传链路、文件 key 约定与展示。触发词：存储、上传、下载、文件、图片、对象存储、S3、COS、预签名、STS、FileUpload、ImageUpload。
---

# 对象存储与文件上传下载

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——文件读写**先复用 `ObjectStorage` 门面 /
`@repo/ui` 组件 / `client.storage` SDK**，不自己调 S3 SDK）。

## 核心要点

- 后端门面 `ObjectStorage`（S3 / COS 双 provider）：`getPresignedUrl` / `getDownloadUrl` /
  `getTemporaryCredentials` / `getObject` / `removeObject`，位于
  `kits/infrastructure/object-storage`。
- 路由 `/storage/*`（三个端点，均 `makeRequireAdminAuth` 管理员鉴权），SDK `client.storage.*`。
- **上传走预签名直传**：前端 `useStorage` 用 `key = md5+ext` 拿预签名 URL → `PUT` 直传，
  业务只存 `key`，不存完整 URL。
- 展示 / 下载：`formatStorageUrl(key)`（web/admin 的 `@/lib/constants`）。
- 组件：`FileUpload` / `ImageUpload` / `FilePreview` / `SortableFileList`（`@repo/ui`）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/storage-guide.md](./references/storage-guide.md) | 门面方法、配置、路由、SDK、前端上传下载链路、key 约定、STS | 做文件上传 / 下载 / 存储时（必读） |

## 完成检查清单

- [ ] 上传走预签名直传（`useStorage` + `ObjectStorage` 门面），未自写 S3 SDK / 大文件过服务端
- [ ] 业务只存 `key`（md5+ext），不存完整 URL；展示用 `formatStorageUrl`
- [ ] 路由复用 `/storage/*` 与 `client.storage.*`，未重复造端点
- [ ] 新文件字段（如 avatar / 附件）已在 schema / 实体 / 表单三处一致接入
- [ ] 配置走 `OBJECT_STORAGE_*` 环境变量，未硬编码桶 / 密钥
