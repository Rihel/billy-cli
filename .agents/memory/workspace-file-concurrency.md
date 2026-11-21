# 工作区文件并发：bash 按工作区串行、写按路径串行、写原子

**查证优先级：抽核**（锁的位置 / 键的构成会变；改 `workspace-runtime.service.ts` 的 exec / fs 后重核）

## 结论（2026-11-22 实现）

同一个工作区会被主 agent、子 agent（最多 3 路并发）同时使用，冲突是三件事，各有对策：

- **bash 串行**：`exec()` 外面套 `execLocks.run(workspaceId, …)`。命令会写什么由模型决定
  （`npm install` / `git checkout` 都会动共享目录），无法预判，只能整个工作区排队。
- **文件写按路径串行**：`fs()` 里写类操作（`write` / `write-bytes` / `append` / `replace` / `remove`）
  套 `fsLocks.run(`\`${workspaceId}:${posix.normalize(path)}\``, …)`；读不排队。
- **写原子**：`write` / `replace` / `write-bytes` 一律「同目录 `.<billy-tmp-xxxx>` → `rename`」
  （容器内是 `cat > tmp && mv -f`）。读端只会看到旧版或新版，不会再读到半截文件。
- **引擎自己的结论不冲突**：子助手结论路径带 `subRunId`（`subagents/<名字>-<subRunId>.md`），
  天然唯一；冲突只发生在模型自由写业务文件时。

锁是**进程内** `KeyedMutex`（`apps/workspace-service/src/workspace/keyed-mutex.ts`）：执行面固定 1 副本、
句柄与回收都在内存里，跨副本语义本来就不成立，不要换成 Redis 锁。

## 坑

- 锁必须放在**执行面**（workspace-service），不能放 agent-runtime：同一工作区可能被多轮 run、
  多个子会话并发调用，runtime 进程内的锁挡不住。
- `fs` 内部调的是 `driver.exec`（`containerFs` 里的 `exec` 辅助函数），**不经过** `exec()`，
  所以写文件不会排在 bash 后面，也不会和 `execLocks` 互相死锁。
- bash 串行是有意为之：一条 30 分钟的命令会挡住同工作区的其它会话，这是「环境是共享场所」的代价；
  要并行就去开工作区，不要放宽这把锁。

## 依据

- `apps/workspace-service/src/workspace/workspace-runtime.service.ts`（`execLocks` / `fsLocks` /
  `writeAtomic` / `containerFs` 的 tmp+mv）
- `apps/workspace-service/src/workspace/keyed-mutex.ts`
- `docs/design/workspace.md` §8（并发语义的设计口径）
- 测试：`apps/workspace-service/test/workspace-runtime.test.ts`（串行 / 原子写 / 按路径排队）、
  `test/keyed-mutex.test.ts`

## 核对命令

```bash
grep -n "execLocks\|fsLocks\|writeAtomic\|MUTATING_FS_OPS" \
  apps/workspace-service/src/workspace/workspace-runtime.service.ts
pnpm --filter @app/workspace-service exec vitest run test/workspace-runtime.test.ts test/keyed-mutex.test.ts
```

## 失效信号

锁挪到 agent-runtime / 引入 Redis 分布式锁 / 工作区改成「一会话一容器」/ 出现读-改-写类新 op
（那时 `fsLocks` 的键要跟着改）。
