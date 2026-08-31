'use client'

import { useServerClient } from '@/lib/server-client'
import { EditOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Form, Input, InputNumber, Select, Switch, Tag } from 'antd'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TableColumnsType } from 'antd'
import {
  ConfirmAction,
  DataTable,
  DisplayValue,
  IconText,
  ModalForm,
  RefreshButton,
  TableActions,
  useDisclosure,
} from '@repo/aui'
import type { AlertRuleModel, UpdateAlertRuleDto } from '@repo/shared'

type RuleForm = {
  name: string
  type: 'tech' | 'business'
  matchCodesText?: string
  keywordsText?: string
  level: 'warn' | 'error'
  channels: ('lark' | 'email')[]
  throttleSeconds: number
  enabled: boolean
}

const CHANNEL_OPTIONS = [
  { label: '飞书', value: 'lark' },
  { label: '邮件', value: 'email' },
]

const ruleToForm = (rule: AlertRuleModel): RuleForm => ({
  name: rule.name,
  type: rule.type,
  matchCodesText: rule.matchCodes.join(','),
  keywordsText: rule.keywords.join(','),
  level: rule.level,
  channels: rule.channels,
  throttleSeconds: rule.throttleSeconds,
  enabled: rule.enabled,
})

const formToRule = (form: RuleForm) => ({
  name: form.name,
  type: form.type,
  matchCodes: (form.matchCodesText ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0),
  keywords: (form.keywordsText ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  level: form.level,
  channels: form.channels,
  throttleSeconds: form.throttleSeconds,
  enabled: form.enabled,
})

export default function AlertRulesPage() {
  const { message } = App.useApp()
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [type, setType] = useState<'tech' | 'business' | undefined>()
  const [enabled, setEnabled] = useState<boolean | undefined>()
  const createDialog = useDisclosure()
  const editDialog = useDisclosure<AlertRuleModel>()
  const [form] = Form.useForm<RuleForm>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['monitor', 'rules', { page, pageSize, keyword, type, enabled }],
    queryFn: () =>
      client.monitor.rule.pageQuery({
        page,
        size: pageSize,
        keyword,
        type,
        enabled,
        orderBy: 'updatedAt',
        order: 'desc',
      }),
  })

  const createMutation = useMutation({
    mutationFn: (input: ReturnType<typeof formToRule>) =>
      client.monitor.rule.create(input),
    onSuccess: () => {
      message.success('规则已创建')
      createDialog.close()
      refetch()
    },
    onError: () => message.error('创建失败'),
  })

  const updateMutation = useMutation({
    mutationFn: (input: UpdateAlertRuleDto) =>
      client.monitor.rule.update(input),
    onSuccess: () => {
      message.success('规则已更新')
      editDialog.close()
      refetch()
    },
    onError: () => message.error('更新失败'),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { ruleId: string }) => client.monitor.rule.remove(input),
    onSuccess: () => {
      message.success('删除成功')
      refetch()
    },
  })

  const columns: TableColumnsType<AlertRuleModel> = [
    { title: '名称', dataIndex: 'name' },
    {
      title: '类型',
      dataIndex: 'type',
      width: 100,
      render: (value: AlertRuleModel['type']) => (
        <Tag color={value === 'tech' ? 'blue' : 'orange'}>
          {value === 'tech' ? '技术' : '业务'}
        </Tag>
      ),
    },
    {
      title: '匹配错误码',
      dataIndex: 'matchCodes',
      width: 180,
      render: (codes: number[]) =>
        codes.length === 0 ? (
          <Tag>全部</Tag>
        ) : (
          codes.map((code) => <Tag key={code}>{code}</Tag>)
        ),
    },
    {
      title: '级别',
      dataIndex: 'level',
      width: 80,
      render: (value: AlertRuleModel['level']) =>
        value === 'error' ? (
          <Tag color="red">error</Tag>
        ) : (
          <Tag color="gold">warn</Tag>
        ),
    },
    {
      title: '通道',
      dataIndex: 'channels',
      width: 140,
      render: (channels: AlertRuleModel['channels']) =>
        channels.map((channel) => (
          <Tag key={channel} color="cyan">
            {channel === 'lark' ? '飞书' : '邮件'}
          </Tag>
        )),
    },
    {
      title: '限频(s)',
      dataIndex: 'throttleSeconds',
      width: 90,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 90,
      render: (value: boolean, record) => (
        <Switch
          checked={value}
          checkedChildren="开"
          unCheckedChildren="关"
          loading={updateMutation.isPending}
          onChange={(checked) => {
            updateMutation.mutate(
              { ruleId: record.id, enabled: checked },
              { onError: () => message.error('操作失败') },
            )
          }}
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value) => <DisplayValue type="date" value={value} />,
    },
    {
      title: '操作',
      width: 140,
      render: (_, record) => (
        <TableActions>
          <IconText
            icon={EditOutlined}
            size="small"
            type="primary"
            onClick={() => {
              form.setFieldsValue(ruleToForm(record))
              editDialog.open(record)
            }}
          >
            编辑
          </IconText>
          <ConfirmAction
            title={`确认删除规则「${record.name}」？`}
            onConfirm={() => removeMutation.mutate({ ruleId: record.id })}
            danger
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  const ruleFormItems = [
    {
      name: 'name' as const,
      label: '规则名称',
      formItemProps: {
        rules: [{ required: true, message: '请输入规则名称' }],
      },
    },
    {
      name: 'type' as const,
      label: '类型',
      formItemProps: { rules: [{ required: true }] },
      render: () => (
        <Select
          options={[
            { label: '技术告警（错误 / 异常）', value: 'tech' },
            { label: '业务告警（指定错误码 / 关键字）', value: 'business' },
          ]}
        />
      ),
    },
    {
      name: 'matchCodesText' as const,
      label: '匹配错误码',
      render: () => (
        <Input placeholder="错误码，逗号分隔，如 1002,3101（留空匹配全部）" />
      ),
    },
    {
      name: 'keywordsText' as const,
      label: '消息关键字',
      render: () => <Input placeholder="关键字，逗号分隔（留空不限制）" />,
    },
    {
      name: 'level' as const,
      label: '级别',
      formItemProps: { rules: [{ required: true }] },
      render: () => (
        <Select
          options={[
            { label: 'error（错误）', value: 'error' },
            { label: 'warn（警告）', value: 'warn' },
          ]}
        />
      ),
    },
    {
      name: 'channels' as const,
      label: '发送通道',
      formItemProps: {
        rules: [{ required: true, message: '至少选择一个通道' }],
      },
      render: () => <Select mode="multiple" options={CHANNEL_OPTIONS} />,
    },
    {
      name: 'throttleSeconds' as const,
      label: '限频窗口（秒）',
      initialValue: 60,
      render: () => <InputNumber min={0} style={{ width: '100%' }} />,
    },
    {
      name: 'enabled' as const,
      label: '启用',
      initialValue: true,
      valuePropName: 'checked',
      render: () => <Switch />,
    },
  ]

  return (
    <div className="w-full h-full bg-white p-5">
      <DataTable<AlertRuleModel>
        title="告警规则"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <Input.Search
              placeholder="搜索规则名..."
              allowClear
              style={{ width: 200 }}
              onSearch={(value) => {
                setKeyword(value || undefined)
                setPage(1)
              }}
            />
            <Select
              allowClear
              placeholder="类型"
              style={{ width: 110 }}
              value={type}
              options={[
                { label: '技术', value: 'tech' },
                { label: '业务', value: 'business' },
              ]}
              onChange={(value) => {
                setType(value)
                setPage(1)
              }}
            />
            <Select
              allowClear
              placeholder="启用状态"
              style={{ width: 110 }}
              value={enabled}
              options={[
                { label: '启用', value: true },
                { label: '禁用', value: false },
              ]}
              onChange={(value) => {
                setEnabled(value)
                setPage(1)
              }}
            />
            <IconText type="primary" icon={PlusOutlined} onClick={() => createDialog.open()}>
              新建规则
            </IconText>
          </>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        dataSource={data?.items}
        page={page}
        pageSize={pageSize}
        total={data?.total}
        onPageChange={(nextPage, nextPageSize) => {
          setPage(nextPage)
          setPageSize(nextPageSize)
        }}
      />

      <ModalForm<RuleForm>
        title="新建规则"
        open={createDialog.isOpen}
        form={form}
        items={ruleFormItems}
        onCancel={createDialog.close}
        onSubmit={async (values) => {
          await createMutation.mutateAsync(formToRule(values))
          createDialog.close()
        }}
      />

      <ModalForm<RuleForm>
        title="编辑规则"
        open={editDialog.isOpen}
        form={form}
        items={ruleFormItems}
        onCancel={editDialog.close}
        onSubmit={async (values) => {
          await updateMutation.mutateAsync({
            ruleId: editDialog.data!.id,
            ...formToRule(values),
          })
          editDialog.close()
        }}
      />
    </div>
  )
}
