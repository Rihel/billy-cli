import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import { withEnvPrefix } from './exec-env.js'

const CONTAINER_WORKDIR = '/workspace'

/** '2g' / '512m' / '1g' → 字节 */
const parseBytes = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?i?b?$/i.exec(value.trim())
  if (!match) return 2 * 1024 ** 3
  const n = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  const mult = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1
  return Math.round(n * mult)
}

const MAX_OUTPUT = 64 * 1024

export interface CommandOutcome {
  code: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface ContainerStartInput {
  name: string
  workspaceId: string
  image: string
  memory: string
  cpus: string
  pidsLimit: number
}

/**
 * 容器后端驱动：Docker（单机 / compose）与 Kubernetes（云端）两套实现。
 *
 * 差异只在「怎么起、怎么 exec、怎么删」；`fs` 都复用 `exec`，所以 driver 不需要感知。
 * 云端多租户**不能用 Docker driver**（要挂 docker.sock = 特权），必须用 Kubernetes driver。
 */
export interface ContainerDriver {
  readonly kind: 'docker' | 'kubernetes'
  /**
   * 只读探测：容器在不在跑、什么时候起的。
   *
   * **不产生副作用**（不创建、不唤醒），所以回收器用它认领孤儿容器是安全的：
   * `ensure` 会把已销毁的环境重新拉起来，用它探活等于每次都把所有工作区唤醒一遍。
   */
  inspect(name: string): Promise<{ running: boolean; startedAt?: number }>
  exists(name: string): Promise<boolean>
  /** 运行中容器实际用的镜像（用于"镜像升级后重建"判定；拿不到返回 null） */
  imageOf(name: string): Promise<string | null>
  start(input: ContainerStartInput): Promise<void>
  exec(
    name: string,
    input: {
      command: string
      cwd: string
      timeoutMs: number
      stdin?: string
      env?: Record<string, string>
    },
  ): Promise<CommandOutcome>
  remove(name: string): Promise<void>
}

const run = (
  bin: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<CommandOutcome> =>
  new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT * 4) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        code: -1,
        stdout,
        stderr: String(error.message),
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })

/** 单机 Docker：compose / 开发机（dockerode 直连 Engine API，不走 docker CLI） */
export class DockerDriver implements ContainerDriver {
  readonly kind = 'docker' as const
  private readonly docker: Docker

  constructor(socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath })
  }

  async inspect(name: string): Promise<{ running: boolean; startedAt?: number }> {
    try {
      const info = await this.docker.getContainer(name).inspect()
      const startedAt = info.State?.StartedAt ? Date.parse(info.State.StartedAt) : Number.NaN
      return {
        running: Boolean(info.State?.Running),
        ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      }
    } catch {
      // 容器不存在（或 daemon 暂时不可达）：当作没在跑，回收器下一轮再看
      return { running: false }
    }
  }

  async exists(name: string): Promise<boolean> {
    return (await this.inspect(name)).running
  }

  async imageOf(name: string): Promise<string | null> {
    const info = await this.docker
      .getContainer(name)
      .inspect()
      .catch(() => null)
    return (info as { Config?: { Image?: string } } | null)?.Config?.Image ?? null
  }

  async start(input: ContainerStartInput): Promise<void> {
    const container = await this.docker.createContainer({
      name: input.name,
      Image: input.image,
      Cmd: ['sleep', 'infinity'],
      Labels: { 'workspace-id': input.workspaceId },
      WorkingDir: CONTAINER_WORKDIR,
      HostConfig: {
        Memory: parseBytes(input.memory),
        NanoCpus: Math.round(Number(input.cpus) * 1_000_000_000),
        PidsLimit: input.pidsLimit,
        NetworkMode: 'bridge',
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { [CONTAINER_WORKDIR]: 'rw' },
      },
    })
    await container.start()
  }

  async exec(
    name: string,
    input: {
      command: string
      cwd: string
      timeoutMs: number
      stdin?: string
      env?: Record<string, string>
    },
  ): Promise<CommandOutcome> {
    const startedAt = Date.now()
    const container = this.docker.getContainer(name)
    // 仅当非空时传 Env：空数组在语义上等价于不传，但会改变请求体，没必要冒这个险
    const env = input.env
      ? Object.entries(input.env).map(([key, value]) => `${key}=${value}`)
      : undefined
    const exec = await container.exec({
      Cmd: ['sh', '-c', input.command],
      WorkingDir: input.cwd,
      ...(env && env.length > 0 ? { Env: env } : {}),
      AttachStdin: input.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
    })
    let timedOut = false
    const stream = await exec.start({ hijack: true, stdin: input.stdin !== undefined })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    // hijack 流是 Docker 的多路复用格式（8 字节帧头），必须 demux，否则输出里混进 \x01\x00...
    this.docker.modem.demuxStream(stream, stdout, stderr)
    if (input.stdin !== undefined) stream.end(input.stdin)
    const timer = setTimeout(() => {
      timedOut = true
      stream.destroy()
    }, input.timeoutMs)
    await new Promise<void>((resolve) => {
      stream.on('end', () => resolve())
      stream.on('close', () => resolve())
      stream.on('error', () => resolve())
    })
    clearTimeout(timer)
    const info = await exec.inspect().catch(() => ({ ExitCode: -1 }))
    return {
      code: timedOut ? -1 : ((info as { ExitCode?: number }).ExitCode ?? -1),
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: Buffer.concat(stderrChunks).toString(),
      durationMs: Date.now() - startedAt,
      timedOut,
    }
  }

  async remove(name: string): Promise<void> {
    await this.docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => undefined)
  }
}

/** 云端 Kubernetes：workspace = 一个 Pod（emptyDir），exec 走 kubectl */
export class KubernetesDriver implements ContainerDriver {
  readonly kind = 'kubernetes' as const

  constructor(
    private readonly bin: string,
    private readonly namespace: string,
  ) {}

  private ns(): string[] {
    return this.namespace ? ['-n', this.namespace] : []
  }

  async inspect(name: string): Promise<{ running: boolean; startedAt?: number }> {
    const out = await run(
      this.bin,
      [
        'get',
        'pod',
        name,
        ...this.ns(),
        '-o',
        'jsonpath={.status.phase}|{.metadata.creationTimestamp}',
      ],
      10_000,
    )
    if (out.code !== 0) return { running: false }
    const [phase, created] = out.stdout.trim().split('|')
    const startedAt = created ? Date.parse(created) : Number.NaN
    return {
      running: phase === 'Running',
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    }
  }

  async exists(name: string): Promise<boolean> {
    return (await this.inspect(name)).running
  }

  async imageOf(name: string): Promise<string | null> {
    const out = await run(
      this.bin,
      ['get', 'pod', name, ...this.ns(), '-o', 'jsonpath={.spec.containers[0].image}'],
      10_000,
    )
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null
  }

  async start(input: ContainerStartInput): Promise<void> {
    const manifest = [
      'apiVersion: v1',
      'kind: Pod',
      'metadata:',
      `  name: ${input.name}`,
      '  labels:',
      '    app: billy-workspace',
      `    workspace-id: "${input.workspaceId}"`,
      'spec:',
      '  restartPolicy: Never',
      '  containers:',
      '    - name: ws',
      `      image: ${input.image}`,
      '      command: ["sleep", "infinity"]',
      '      workingDir: /workspace',
      '      resources:',
      '        limits:',
      `          memory: ${input.memory}`,
      `          cpu: "${input.cpus}"`,
      '      volumeMounts:',
      '        - name: workspace',
      '          mountPath: /workspace',
      '  volumes:',
      '    - name: workspace',
      '      emptyDir: {}',
      '',
    ].join('\n')
    const out = await run(this.bin, ['apply', '-f', '-', ...this.ns()], 60_000, manifest)
    if (out.code !== 0) throw new Error(`创建 Pod 失败：${out.stderr.slice(0, 500)}`)
    // 等 Pod 可 exec（最多 60s）
    const deadline = Date.now() + 60_000
    for (;;) {
      const phase = await run(
        this.bin,
        ['get', 'pod', input.name, ...this.ns(), '-o', 'jsonpath={.status.phase}'],
        10_000,
      )
      if (phase.stdout.trim() === 'Running') return
      if (Date.now() > deadline) throw new Error('Pod 启动超时')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  exec(
    name: string,
    input: {
      command: string
      cwd: string
      timeoutMs: number
      stdin?: string
      env?: Record<string, string>
    },
  ): Promise<CommandOutcome> {
    // env 前缀只对紧随其后的一条命令生效，必须放在 `cd ... &&` 之后：
    // 放在最前面会变成 `env 'K=V' cd ...`，而 cd 是 shell 内建命令、env 找不到可执行文件，整条命令会直接失败。
    const script = `cd ${JSON.stringify(input.cwd)} && ${withEnvPrefix(input.command, input.env)}`
    return run(
      this.bin,
      ['exec', name, ...this.ns(), '--', 'sh', '-c', script],
      input.timeoutMs,
      input.stdin,
    )
  }

  async remove(name: string): Promise<void> {
    await run(this.bin, ['delete', 'pod', name, ...this.ns(), '--ignore-not-found'], 30_000)
  }
}
