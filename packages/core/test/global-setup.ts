import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const initSql = fileURLToPath(
  new URL('../../../docker/init-db.sql', import.meta.url),
)

export default function setup() {
  execFileSync(
    'docker',
    ['compose', 'up', '-d', '--wait', 'postgres', 'redis', 'minio'],
    { cwd: workspaceRoot, stdio: 'inherit' },
  )

  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'root',
      '-d',
      'billy-cli',
    ],
    {
      cwd: workspaceRoot,
      input: readFileSync(initSql),
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  )

  if (result.status !== 0) {
    throw new Error(
      `Failed to initialize test database (exit ${result.status})`,
    )
  }

  return function teardown() {
    execFileSync('docker', ['compose', 'down', '--remove-orphans'], {
      cwd: workspaceRoot,
      stdio: 'inherit',
    })
  }
}
