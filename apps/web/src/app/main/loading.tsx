import { Layout } from 'antd'
import { Content } from 'antd/es/layout/layout'
import { Spin } from 'antd'

export default function MainLoading() {
  return (
    <Layout className="w-screen h-screen">
      <Content className="flex items-center justify-center">
        <Spin size="large" />
      </Content>
    </Layout>
  )
}
