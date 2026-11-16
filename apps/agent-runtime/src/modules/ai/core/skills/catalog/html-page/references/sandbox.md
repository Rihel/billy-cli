# 预览环境：沙箱里能加载什么

页面在后台的**沙箱 iframe** 里跑：`sandbox="allow-scripts"`，**没有 same-origin** ——
拿不到后台页面的 cookie 与 DOM，也连不出去。理解这一层，下面的规则就不需要背。

## CSP 只放行两类资源

1. 内联的 `<style>` / `<script>`；
2. 三家 CDN 上的脚本 / 样式 / 图片 / 字体 / 音视频：

| 顺位 | CDN | 同一个文件的地址 |
| --- | --- | --- |
| 国内 | `registry.npmmirror.com` | `https://registry.npmmirror.com/<包>/<版本>/files/<包内路径>` |
| 海外 | `cdn.jsdelivr.net` | `https://cdn.jsdelivr.net/npm/<包>@<版本>/<包内路径>` |
| 兜底 | `unpkg.com` | `https://unpkg.com/<包>@<版本>/<包内路径>` |

同一个库的三条地址必须是**同一个包内路径**，只换前缀与版本写法。

## 其他地址一律加载不出来

`fetch` / XHR / WebSocket（`connect-src 'none'`）、表单提交、`<iframe>`、`<base>`、
Google Fonts、cdnjs、GitHub raw、自建图床 —— 写了只会得到一块空白，**而且不会报错**。

例外：`data:` / `blob:` 的图片、字体、音视频可以（`img-src data: blob:`），
所以小图标可以直接内联成 data URI。

## 推论

- **数据必须内联**：把 JSON 直接写进 `<script>`，或先渲染成 HTML 节点；页面不能自己请求接口；
- **单文件**：预览只有一份文本、没有第二份文件，相对路径必然落空（源码拆片段，用构建脚本合成）；
- **1MB 截断**：预览只读文本前 1MB，大表先聚合 / 抽样，别把几万行原始数据塞进来；
- **窄屏不横向溢出**：宽表格套 `overflow-x:auto`。
