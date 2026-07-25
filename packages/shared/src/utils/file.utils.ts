import SparkMD5 from 'spark-md5'

export function jsonToBlobUrl(json: any, type = 'application/json') {
  try {
    // 将 JSON 对象转换为格式化的字符串
    const jsonString = JSON.stringify(json, null, 2)
    // 创建 Blob 对象
    const blob = new Blob([jsonString], { type })
    // 生成 Blob URL
    return URL.createObjectURL(blob)
  } catch (error) {
    console.error('JSON 转换为 Blob URL 失败:', error)
    return null
  }
}
export async function getFileMd5(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunkSize = 1024 * 1024 * 2 // 分块大小 2MB
    const chunks = Math.ceil(file.size / chunkSize)
    let currentChunk = 0
    const spark = new SparkMD5.ArrayBuffer()
    const fileReader = new FileReader()

    fileReader.onload = (e) => {
      if (e.target?.result) {
        spark.append(e.target.result as ArrayBuffer)
        currentChunk++
        if (currentChunk < chunks) {
          loadNextChunk()
        } else {
          resolve(spark.end())
        }
      }
    }

    fileReader.onerror = (e) => reject(e)

    const loadNextChunk = () => {
      const start = currentChunk * chunkSize
      const end = start + chunkSize >= file.size ? file.size : start + chunkSize
      fileReader.readAsArrayBuffer(file.slice(start, end))
    }

    loadNextChunk()
  })
}
export function saveAsJson(json: Record<string, any>, filename: string) {
  const str = JSON.stringify(json, null, 2)
  const blob = new Blob([str], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.style.display = 'none'
  link.download = filename + '.json'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function download(url: string, filename: string) {
  const link = document.createElement('a')
  link.href = url
  link.style.display = 'none'
  link.target = '_blank'
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export function downloadFromBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  download(url, filename)
  URL.revokeObjectURL(url)
}

export function saveAsXlsx(buf: ArrayBuffer, filename: string) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.style.display = 'none'
  link.download = filename + '.xlsx'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export async function getFileBuffer(file: File | Blob) {
  const arrayBuffer = await file.arrayBuffer()
  const buffer = new Uint8Array(arrayBuffer)
  return buffer
}

// export async function getFileMd5(file: File) {
//   const arrayBuffer = await getFileBuffer(file)
//   const buffer = crypto.lib.WordArray.create(arrayBuffer)
//   const result = crypto.MD5(buffer).toString(crypto.enc.Hex)
//   return result
// }

export function getFileExtName(filename: string) {
  const match = filename.match(/\.*(\..*)$/)
  if (match) {
    return match[1]
  }
  return null
}

export type FileInfo = {
  fileSize: number
  name: string
  type: string
  id: string
  md5: string
  ext: string | null
  extname: string | undefined
  size: string
}
export async function getFileInfo(file: File): Promise<FileInfo> {
  const fileMd5 = (await getFileMd5(file)) as string
  console.log('fileMd5', fileMd5)
  const ext = getFileExtName(file.name)
  return {
    fileSize: file.size,
    name: file.name,
    type: file.type,
    id: fileMd5,
    md5: fileMd5,
    ext,
    extname: ext?.replace('.', ''),
    size: (+file.size / 1024).toFixed(1) + 'KB',
  }
}

export function formatFileSize(size: number) {
  const kb = 1024
  const mb = kb * kb
  const gb = mb * 1024
  const tb = gb * 1024
  if (size < 1024) {
    return `${size} byte`
  } else if (size >= kb && size < mb) {
    return (size / kb).toFixed(2) + 'kb'
  } else if (size >= mb && size < gb) {
    return (size / mb).toFixed(2) + 'mb'
  } else if (size >= gb && size < tb) {
    return (size / gb).toFixed(2) + 'gb'
  } else if (size >= tb) {
    return (size / tb).toFixed(2) + 'tb'
  }
}

export function getJsonSize(jsonObj: Record<string, any>) {
  const jsonString = JSON.stringify(jsonObj)
  let jsonSize = 0

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString.charCodeAt(i)

    if (char <= 0x7f) {
      jsonSize += 1
    } else if (char <= 0x7ff) {
      jsonSize += 2
    } else if (char <= 0xffff) {
      jsonSize += 3
    } else {
      jsonSize += 4
    }
  }

  return jsonSize
}

export function isBase64Image(str: string) {
  return /^data:image\/(png|jpg|jpeg|gif|bmp|webp);base64,/.test(str)
}

export function isImageUrl(value: string) {
  return /^(?:https?:)|^(data:image\/.*)/.test(value)
}

export function isVideoLink(value: string) {
  return /\.(mp4|webm|ogg|mov|avi|flv|wmv)$/.test(value)
}

export function base64ToBlob(base64: string, mimeType: string) {
  // 去掉Base64头部信息，如果有的话
  const byteCharacters = atob(base64.split(',')[1] || base64)
  const byteNumbers = new Array(byteCharacters.length)

  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }

  const byteArray = new Uint8Array(byteNumbers)
  return new Blob([byteArray], { type: mimeType })
}

export function getImageSize(url: string | Blob) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    let src: string
    if (url instanceof Blob) {
      src = URL.createObjectURL(url)
    } else {
      src = url as string
    }
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.width, height: img.height })
      URL.revokeObjectURL(src)
    }
    img.onerror = reject
    img.src = src
  })
}
