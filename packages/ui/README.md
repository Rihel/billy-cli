# @repo/ui

应用无关的 React UI 与交互能力包。允许依赖 React、Ant Design、ahooks 和
`@repo/shared`，不得依赖具体应用、路由、tRPC 或业务 Store。

## Hook 迁移原则

迁移 `rihel-base/client-kits` 时先检查 `@repo/shared`，再优先使用成熟第三方库、
Ant Design 和 ahooks 3.9.7。只有现有实现缺少领域语义或无法覆盖完整行为时，
才在本包保留自定义 Hook 或组件。

| 旧 Hook            | 决策         | 当前替代                                                   |
| ------------------ | ------------ | ---------------------------------------------------------- |
| `useApiRequest`    | 不迁移       | TanStack Query + tRPC                                      |
| `useAppStorage`    | 语义重写     | `StorageProvider` / `useStorageAdapter`                    |
| `useBaseForm`      | 不迁移       | Ant Design Form + mutation + `ModalForm`                   |
| `useCtrl`          | 不迁移       | ahooks `useControllableValue`                              |
| `useEntityDict`    | 不迁移       | `useMemo(() => createDictByDataSource(...))`               |
| `useFloatForm`     | 不迁移       | `useDisclosure` + `ModalForm` / `DrawerForm`               |
| `useFloat`         | 语义重写     | `useDisclosure`，内部复用 ahooks `useBoolean`              |
| `useForceUpdate`   | 不迁移       | ahooks `useUpdate`                                         |
| `useMediaQuery`    | 不迁移       | ahooks `useResponsive` / `configResponsive`                |
| `useMergeProps`    | 按需重写     | Context + props 的组件级合并函数                           |
| `useNextTick`      | 不迁移       | React effect；确需调度时使用微任务或 rAF                   |
| `usePasteFiles`    | 保留语义包装 | 内部复用 ahooks `useEventListener`                         |
| `useRafState`      | 不迁移       | ahooks `useRafState`                                       |
| `useRectInfo`      | 保留并重写   | `useRect`，ahooks `useSize/useScroll` 无法完整覆盖         |
| `useRefreshEffect` | 不迁移       | ahooks `useUpdateEffect` + `useUpdate`                     |
| `useRequest`       | 不迁移       | TanStack Query；纯 UI 异步场景用 ahooks `useRequest`       |
| `useResettable`    | 不迁移       | ahooks `useResetState`                                     |
| `useResolveData`   | 不迁移       | props/context/default 的普通优先级函数                     |
| `useRoute`         | 不进入 UI 包 | Next.js 应用层路由 Hook                                    |
| `useRouter`        | 不进入 UI 包 | Next.js 应用层路由 Hook                                    |
| `useUploader`      | 语义重写     | 基于 `StorageProvider`，异步状态可复用 ahooks `useRequest` |

## 组件迁移检查

迁移组件前按以下顺序判断：

1. `@repo/shared` 是否已有可复用的 schema、字典、格式化、文件或异步能力。
2. 是否存在成熟、持续维护且兼容 React 19 的第三方实现。
3. Ant Design 或 ahooks 是否已经提供同等组件、Hook 或组合能力。
4. 第三方实现是否支持 TypeScript、ESM、SSR 和按需构建，许可证是否兼容。
5. 引入依赖的体积和维护成本是否低于自研成本，是否避免依赖非公开内部包。
6. 组件是否依赖旧 IOC、React Router、API 类型或业务字典。
7. 能否通过 adapter、render prop 或回调注入解除应用依赖。
8. 迁移后是否至少有一个当前应用的真实使用场景。

选型优先级固定为：

1. `@repo/shared` 已有公共能力。
2. 已安装依赖提供的公开 API。
3. 技术栈官方或生态主流第三方库。
4. 对公共能力做轻量 UI 语义封装。
5. 没有可靠实现时才自研底层能力。

不得因为某依赖被 Ant Design 间接安装就直接引用它，例如当前 lockfile 中的
`@rc-component/virtual-list`。只有项目显式声明的直接依赖才能作为公共包 API 的
实现基础。

## 旧组件候选映射

迁移下列能力前，先评估对应的成熟实现：

| 旧能力                | 优先评估                                          | 当前决策                                              |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `ListWrap` / 虚拟网格 | `@tanstack/react-virtual`、`react-virtuoso`       | 不搬旧虚拟化内核                                      |
| `DataTable`           | Ant Design Table、`@ant-design/pro-table`         | 已基于 `PaginationTable` 组合受控查询布局             |
| `DataList`            | Ant Design List、TanStack Query                   | 已迁移受控展示和加载更多，不接管请求缓存              |
| `FormRenderer`        | Ant Design Form、Formily、JSON Forms              | 已迁移基础 Schema 和显式自定义渲染，不设全局 registry |
| 拖拽排序              | `@dnd-kit/core` / `@dnd-kit/sortable`             | 不自研拖拽引擎                                        |
| 文件拖拽上传          | Ant Design Upload/Dragger、Uppy                   | 简单场景用 Ant Design，复杂续传再评估 Uppy            |
| 图片裁剪              | `react-easy-crop`、`antd-img-crop`                | 需要头像裁剪时引入，不自研裁剪算法                    |
| 浮层定位              | Ant Design Popover/Dropdown、`@floating-ui/react` | 常规场景使用 Ant Design                               |
| `FullscreenContent`   | ahooks `useFullscreen` + 原生布局                 | 仅保留轻量 UI 包装                                    |
| `IconPicker`          | 当前图标库公开元数据、Iconify 生态                | 确定图标源后实现选择 UI                               |
| Excel 导入导出        | SheetJS、ExcelJS                                  | 放入独立能力包，不在 UI 包解析文件格式                |
| 富文本编辑器          | Tiptap、Lexical                                   | 按业务需求选型，不自研编辑器内核                      |
| 图表                  | Apache ECharts、Ant Design Charts                 | 通过 adapter 封装主题和空状态                         |
| `ScrollShadow`        | CSS scroll-state（兼容时）或 `useRect`            | 当前浏览器兼容要求下使用 `useRect`                    |
| `AsyncSelect`         | Ant Design Select + ahooks `useRequest`           | 只封装加载、刷新和新增选项语义                        |
| `StateView`           | Ant Design Spin/Result/Empty                      | 做组合组件，不重写状态控件                            |

引入新的运行时依赖前，需要记录选择理由、替代方案、包体积影响和维护状态；只为
一个很薄的样式包装不新增依赖。

不要从本包重新导出 ahooks。调用方需要通用 Hook 时直接从 `ahooks` 导入，
本包只导出具有额外 UI 或领域语义的封装。

## 状态管理约定

- 组件内的复合对象、数组和多字段草稿状态默认使用 Immer / `useImmer`。
- 布尔值、字符串、DOM 引用等原子状态可使用 `useBoolean` 或 `useState`。
- 请求缓存、服务端状态和分页数据由 TanStack Query 管理，不复制到 Immer Store。
- 并发异步流程需要同时保证状态更新基于最新快照，不能只依赖闭包中的 state。
