/** 文件能力的部署上限（与 server 的 ToolEnvCaps.file 同形） */
export interface FileEnvCaps {
  maxBytesMax?: number
  maxFilesMax?: number
  maxTotalBytesMax?: number
  readMaxBytesMax?: number
  pageLinesMax?: number
  pageCharsMax?: number
  writeBytesMax?: number
  searchFilesMax?: number
  searchBytesMax?: number
  searchResultsMax?: number
  workspaceFilesMax?: number
  workspaceDepthMax?: number
}

/** FileService 需要的部署能力：工作区根 + 文件上限 */
export interface FileCaps {
  command?: { workDir?: string }
  file?: FileEnvCaps
}

/** 注入 token（server 绑定 TOOL_ENV_CAPS，worker 绑定自己的 config） */
export const FILE_CAPS = Symbol.for('FileCaps')
