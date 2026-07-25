import SparkMD5 from 'spark-md5'
export function createJsonMd5(json = {}) {
  try {
    const content = JSON.stringify(json)
    return SparkMD5.hash(content)
  } catch (error) {
    console.warn(error)
  }
  return null
}

export function createMd5(content = '') {
  return SparkMD5.hash(content)
}
