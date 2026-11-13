export async function copy(text: string) {
  if (!navigator.clipboard) {
    const textarea = document.createElement('textarea')
    try {
      document.body.appendChild(textarea)
      textarea.value = text
      textarea.select()
      if (!document.execCommand('copy')) throw new Error('复制失败')
    } finally {
      textarea.remove()
    }
  } else {
    await navigator.clipboard.writeText(text)
  }
}

const cache = new Map<string, string>()
export function generateLetterAvatar(name: string, bgColor: string = '#1677ff') {
  const letter = name?.slice(0, 1)?.toLocaleUpperCase() || 'U'
  const cacheKey = `${name}\u0000${bgColor}`
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)
  }

  const canvas = document.createElement('canvas')
  canvas.width = 100
  canvas.height = 100

  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = bgColor

  ctx.fillRect(0, 0, 100, 100)
  ctx.fillStyle = '#fff'
  ctx.font = '60px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(letter, 50, 50)

  const url = canvas.toDataURL('image/png')
  cache.set(cacheKey, url)
  return url
}

export type ReadFileFormat = 'text' | 'arraybuffer' | 'dataURL' | 'json'
export function readFile(file: File | Blob, format: ReadFileFormat = 'text') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = reader.result
      if (format === 'json') {
        try {
          resolve(JSON.parse(res as string))
        } catch (error) {
          resolve(null)
        }
      } else {
        resolve(reader.result)
      }
    }

    reader.onerror = () => {
      reject(reader.error)
    }
    switch (format) {
      case 'arraybuffer':
        reader.readAsArrayBuffer(file)

        break
      case 'dataURL':
        reader.readAsDataURL(file)
        break
      case 'text':
      case 'json':
      default:
        reader.readAsText(file)
        break
    }
  })
}
