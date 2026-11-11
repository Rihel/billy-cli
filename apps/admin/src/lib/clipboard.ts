/**
 * 复制文本到系统剪贴板。
 *
 * 优先用 `navigator.clipboard`（https / localhost）；内网 http 部署没有安全上下文，
 * 退回到临时 textarea + `document.execCommand('copy')`。两条都不行才报错，不能静默失败。
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 权限被拒 / 非安全上下文：继续尝试 execCommand
    }
  }

  if (typeof document !== 'undefined') {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-9999px'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    if (copied) return
  }

  throw new Error('当前环境不支持剪贴板（需要 https / localhost，或浏览器剪贴板权限）')
}
