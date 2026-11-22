# 工作区文件并发：bash 按工作区串行、写按路径串行、写原子

**查证优先级：抽核**（锁的位置 / 键的构成会变；改 `workspace-runtime.service.ts` 的 exec / fs 后重核）

## 结论（2026-11-22 实现）

同一个工作区会被主 agent、子 agent（最多 3 路并发）同时使用，冲突是三件事，各有对策：

- **bash 串行**：`exec()` 外面套 workspace 级 `exec` 锁（单副本 `KeyedMutex`，多副本 Redis）。命令会写什么由模型决定
  （`npm install` / `git checkout` 都会动共享目录），无法预判，只能整个工作区排队。
- **文件写按路径串行**：`fs()` 里写类操作（`write` / `write-bytes` / `append` / `replace` / `remove`）
  套 `fs` 锁（键 `workspaceId:posix.normalize(path)`）；读不排队。
- **写原子**：`write` / `replace` / `write-bytes` 一律「同目录 `.<billy-tmp-xxxx>` → `rename`」
  （容器内是 `cat > tmp && mv -f`）。读端只会看到旧版或新版，不会再读到半截文件。
- **引擎自己的结论不冲突**：子助手结论路径带 `subRunId`（`subagents/<名字>-<subRunId>.md`），
  天然唯一；冲突只发生在模型自由写业务文件时。

锁分两种模式（`apps/workspace-service/src/workspace/workspace-coordinator.ts`）：

- **单副本**（local / 同宿主 Docker）：`KeyedMutex`，进程内串行，不依赖 Redis；
- **多副本**（k8s，`WORKSPACE_MULTI_INSTANCE=true`）：`RedisLockService`，`lifecycle` / `exec` / `fs`
  三把锁按 workspace / path 共享，`lastUsed` 也放 Redis。Docker 跨宿主 / local 后端仍只允许单副本。

## 坑

- 锁必须放在**执行面**（workspace-service），不能放 agent-runtime：同一工作区可能被多轮 run、
  多个子会话并发调用，runtime 进程内的锁挡不住。
- `fs` 内部调的是 `driver.exec`（`containerFs` 里的 `exec` 辅助函数），**不经过** `exec()`，
  所以写文件不会排在 bash 后面，也不会和 `exec` 锁互相死锁。
- bash 串行是有意为之：一条 30 分钟的命令会挡住同工作区的其它会话，这是「环境是共享场所」的代价；
  要并行就去开工作区，不要放宽这把锁。

## 依据

- `apps/workspace-service/src/workspace/workspace-runtime.service.ts`（`withLock('exec'/'fs')` /
  `writeAtomic` / `containerFs` 的 tmp+mv）
- `apps/workspace-service/src/workspace/keyed-mutex.ts`
- `apps/workspace-service/src/workspace/workspace-coordinator.ts`
- `docs/design/workspace.md` §8（并发语义的设计口径）
- 测试：`apps/workspace-service/test/workspace-runtime.test.ts`（串行 / 原子写 / 按路径排队）、
  `test/keyed-mutex.test.ts`

## 核对命令

```bash
grep -n "withLock\|tryWithLock\|writeAtomic\|MUTATING_FS_OPS" \
  apps/workspace-service/src/workspace/workspace-runtime.service.ts \
  apps/workspace-service/src/workspace/workspace-coordinator.ts
pnpm --filter @app/workspace-service exec vitest run test/workspace-runtime.test.ts test/keyed-mutex.test.ts
```

## 失效信号

锁挪到 agent-runtime / 工作区改成「一会话一容器」/ 出现读-改-写类新 op（`fs` 锁键要跟着改）/
多副本改成「任意副本都能处理」以外的模型（如 workspace 归属租约）。
