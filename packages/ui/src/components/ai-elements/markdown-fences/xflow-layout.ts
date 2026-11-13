/**
 * 流程图排版：用 React Flow 官方示例推荐的 dagre（`@dagrejs/dagre`）。
 *
 * 为什么换成官方方案：先前是自己写的「最长路径分层」，只对树和单向链好看 ——
 * 交叉边、菱形分叉、回边一多就会叠在一起，而且不会为连线留通道。dagre 是分层布局
 * （Sugiyama 一类）的成熟实现，会做**层内排序**（减少交叉）与**坐标优化**，这也是
 * React Flow 文档自己给的布局示例用的库。
 *
 * 独立成文件是为了**按需加载**：dagre 有百来 KB，不该因为聊天页注册了 xflow 就进首屏包 ——
 * 只有真的出现一张流程图时才由 `xflow-canvas` 把它拉进来。
 */
import dagre from '@dagrejs/dagre'

import type { XflowModel, XflowNode } from './fence-spec.ts'

/** 节点卡片的尺寸：与 `xflow-canvas` 里的样式同一套数字（改一处要一起改） */
export const XFLOW_NODE_SIZE = { width: 208, height: 84 } as const

/** 层间距（连线的方向）与同层节点间距（垂直于连线的方向） */
const RANK_SEP = 72
const NODE_SEP = 32

/** 排版结果里的节点：位置是画布坐标系里的左上角 */
export interface XflowPlacedNode extends XflowNode {
  x: number
  y: number
}

export interface XflowLayout {
  nodes: XflowPlacedNode[]
  /** 内容尺寸，供外层容器决定高度 */
  width: number
  height: number
}

/**
 * 按图结构排版。
 *
 * 约定：**输入顺序不影响结果**（dagre 会自己排层内顺序），同一份数据每次画出来都一样；
 * 有环也不报错（dagre 按"打破回边"处理），节点多时只会更宽更高。
 */
export const layoutXflow = (model: XflowModel): XflowLayout => {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({
    rankdir: model.direction === 'TB' ? 'TB' : 'LR',
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: 0,
    marginy: 0,
  })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const node of model.nodes) {
    graph.setNode(node.id, { width: XFLOW_NODE_SIZE.width, height: XFLOW_NODE_SIZE.height })
  }
  for (const edge of model.edges) {
    graph.setEdge(edge.from, edge.to)
  }

  dagre.layout(graph)

  const nodes = model.nodes.map((node) => {
    // dagre 给的是**中心点**坐标，React Flow 要左上角
    const point = graph.node(node.id) as { x: number; y: number } | undefined
    return {
      ...node,
      x: (point?.x ?? 0) - XFLOW_NODE_SIZE.width / 2,
      y: (point?.y ?? 0) - XFLOW_NODE_SIZE.height / 2,
    }
  })

  const size = graph.graph() as { width?: number; height?: number }

  return { nodes, width: size.width ?? 0, height: size.height ?? 0 }
}
