'use client'

import { useEffect, useMemo, useState } from 'react'
import type { AiConnectorCatalogEntry, AiConnectorCreateDto, AiConnectorModel, AiConnectorUpdateDto } from '@repo/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
  Textarea,
} from '@repo/ui'

/**
 * 连接器表单（新建 / 编辑）。
 *
 * 字段不是写死的：**由目录条目声明**（`catalog.fields`）渲染，`secret: true` 的进 `secrets`，
 * 其余进 `config`。这样加一种型号不用改这个文件。
 *
 * 两条与后端一致的规则：
 * - 新建时 `key` 与 `catalogKind` 不可改（key 会成为工具 key 前缀）；
 * - 编辑时密钥输入框留空 = 不改；要清空得显式勾「清空密钥」。
 */

export type ConnectorFormModalProps = {
  open: boolean
  catalog: readonly AiConnectorCatalogEntry[]
  /** null = 新建 */
  editing: AiConnectorModel | null
  saving: boolean
  onClose: () => void
  onCreate: (dto: AiConnectorCreateDto) => Promise<void>
  onUpdate: (dto: AiConnectorUpdateDto) => Promise<void>
}

type FieldValues = Record<string, string>

/** 每种型号的默认值（只是省手输，后端 schema 才是唯一事实源） */
const DEFAULTS: Record<string, FieldValues> = {
  postgres: { host: '127.0.0.1', port: '5432', database: 'postgres', user: 'postgres' },
  mysql: { host: '127.0.0.1', port: '3306', database: '', user: '' },
  redis: { host: '127.0.0.1', port: '6379', db: '0', keyPrefix: '' },
}

const entryOf = (
  catalog: readonly AiConnectorCatalogEntry[],
  kind: string | undefined,
): AiConnectorCatalogEntry | undefined => catalog.find((entry) => entry.kind === kind)

export function ConnectorFormModal({
  open,
  catalog,
  editing,
  saving,
  onClose,
  onCreate,
  onUpdate,
}: ConnectorFormModalProps) {
  const [kind, setKind] = useState<string>('')
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [values, setValues] = useState<FieldValues>({})
  const [clearSecrets, setClearSecrets] = useState(false)

  const entry = useMemo(() => entryOf(catalog, kind), [catalog, kind])

  useEffect(() => {
    if (!open) return
    if (editing) {
      setKind(editing.catalogKind || editing.driver)
      setName(editing.name)
      setKey(editing.key)
      setEnabled(editing.enabled)
      const next: FieldValues = {}
      for (const [fieldKey, value] of Object.entries(editing.config)) {
        next[fieldKey] = value == null ? '' : String(value)
      }
      setValues(next)
      setClearSecrets(false)
      return
    }
    const first = catalog.find((item) => item.phase === 'available')
    setKind(first?.kind ?? '')
    setName('')
    setKey('')
    setEnabled(true)
    setValues(first ? { ...(DEFAULTS[first.kind] ?? {}) } : {})
    setClearSecrets(false)
  }, [open, editing, catalog])

  const switchKind = (nextKind: string): void => {
    setKind(nextKind)
    setValues({ ...(DEFAULTS[nextKind] ?? {}) })
  }

  const submit = async (): Promise<void> => {
    if (!entry) return
    const config: Record<string, unknown> = {}
    const secrets: Record<string, string> = {}
    for (const field of entry.fields) {
      const raw = values[field.key]?.trim() ?? ''
      if (field.secret) {
        if (raw) secrets[field.key] = raw
        continue
      }
      if (raw === '') continue
      config[field.key] = field.type === 'number' ? Number(raw) : raw
    }

    if (editing) {
      await onUpdate({
        id: editing.id,
        name,
        config,
        secrets: clearSecrets
          ? Object.fromEntries(entry.fields.filter((f) => f.secret).map((f) => [f.key, '']))
          : Object.keys(secrets).length > 0
            ? secrets
            : undefined,
        enabled,
      })
      return
    }

    await onCreate({
      key,
      name,
      catalogKind: entry.kind,
      driver: entry.driver,
      config,
      secrets,
      enabled,
    })
  }

  const secretHint = (fieldKey: string): string => {
    const hint = editing?.secretHints.find((item) => item.name === fieldKey)
    return hint?.hint ?? (hint ? '未配置' : '')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑连接器「${editing.name}」` : '新建连接器'}</DialogTitle>
          <DialogDescription>
            填地址与凭证；保存后点「测试」验证连通，再点「同步」把它的工具登记进模型。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {editing ? null : (
            <div className="flex flex-col gap-2">
              <Label>型号</Label>
              <div className="flex flex-wrap gap-2">
                {catalog.map((item) => (
                  <Button
                    key={item.kind}
                    type="button"
                    variant={item.kind === kind ? 'default' : 'outline'}
                    size="sm"
                    disabled={item.phase !== 'available'}
                    onClick={() => switchKind(item.kind)}
                  >
                    {item.name}
                    {item.phase !== 'available' ? '（未开放）' : ''}
                  </Button>
                ))}
              </div>
              {entry?.authHint ? (
                <p className="text-xs text-muted-foreground">{entry.authHint}</p>
              ) : null}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-name">名称</Label>
              <Input
                id="connector-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="如：订单库（只读）"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-key">key</Label>
              <Input
                id="connector-key"
                value={key}
                disabled={Boolean(editing)}
                onChange={(event) => setKey(event.target.value.toLowerCase())}
                placeholder="如：orders-pg"
              />
              <span className="text-xs text-muted-foreground">
                会成为工具 key 的前缀，创建后不可改
              </span>
            </div>
          </div>

          {entry?.fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`field-${field.key}`}>
                {field.label}
                {field.required ? <span className="text-destructive"> *</span> : null}
              </Label>
              <Input
                id={`field-${field.key}`}
                type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
                value={values[field.key] ?? ''}
                placeholder={
                  field.secret ? secretHint(field.key) || field.placeholder || '' : field.placeholder || ''
                }
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
              />
              {field.help ? <span className="text-xs text-muted-foreground">{field.help}</span> : null}
              {field.secret && editing ? (
                <span className="text-xs text-muted-foreground">
                  留空 = 不修改；当前：{secretHint(field.key) || '未配置'}
                </span>
              ) : null}
            </div>
          ))}

          {editing ? (
            <>
              <div className="flex items-center gap-2">
                <Switch checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
                <span className="text-sm">启用（关掉后它产出的工具立刻不可调）</span>
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearSecrets}
                  onChange={(event) => setClearSecrets(event.target.checked)}
                />
                清空已配置的密钥
              </label>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving || !entry || !name || !key}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 详情里展示的只读配置（避免把密钥带出来） */
export function ConfigPreview({ config }: { config: Record<string, unknown> }) {
  return (
    <Textarea readOnly rows={4} value={JSON.stringify(config, null, 2)} className="font-mono text-xs" />
  )
}
