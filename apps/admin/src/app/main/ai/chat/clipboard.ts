/**
 * 复制文本到系统剪贴板。
 *
 * 为什么单独一个模块：会话页有两处要复制（页头的会话 id、每条消息），
 * 而 `navigator.clipboard` 只在**安全上下文**（https / localhost）里有 ——
 * 内网用 http 打开的部署会没有它，这时候**必须报错给用户**，
 * 不能静默失败（"点了复制、粘出来是空的"是最难查的那种坏）。
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('当前环境不支持剪贴板（需要 https 或 localhost）')
  }
  await navigator.clipboard.writeText(text)
}
