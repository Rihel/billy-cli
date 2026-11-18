import { describe, expect, it } from 'vitest'
import { searchTools, tokenize } from '../src/registry/tool.search.js'

const docs = [
  { key: 'maps-weather', title: '查天气', description: '按城市查询指定城市的天气', tags: ['天气'] },
  { key: 'maps-geo', title: '地理编码', description: '把地址转成经纬度坐标', tags: ['地图'] },
  { key: 'file-list', title: '列文件', description: '列出会话工作区里的文件', tags: ['文件'] },
  { key: 'bash', title: '执行命令', description: '在本机执行一条命令行命令', tags: ['命令'] },
]

describe('BM25 工具检索', () => {
  it('中文按 unigram + bigram 切词', () => {
    expect(tokenize('查天气')).toEqual(expect.arrayContaining(['查', '天', '气', '查天', '天气']))
    expect(tokenize('file-list')).toEqual(expect.arrayContaining(['file', 'list']))
  })

  it('中文查询命中对应工具（天气 → maps-weather）', () => {
    const hits = searchTools('帮我查一下明天北京的天气', docs)
    expect(hits[0]?.doc.key).toBe('maps-weather')
    expect(hits[0]?.score).toBeGreaterThan(0)
  })

  it('英文 / 工具名查询命中对应工具（file list → file-list）', () => {
    const hits = searchTools('file list', docs)
    expect(hits[0]?.doc.key).toBe('file-list')
  })

  it('limit 生效；空查询与无命中返回空数组', () => {
    expect(searchTools('查 天气 文件 命令', docs, 2)).toHaveLength(2)
    expect(searchTools('   ', docs)).toEqual([])
    expect(searchTools('量子纠缠', docs)).toEqual([])
  })
})
