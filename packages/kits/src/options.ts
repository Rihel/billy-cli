export const KITS_MODULE_OPTIONS = Symbol('KITS_MODULE_OPTIONS')
export const DATABASE_MODULE_OPTIONS = Symbol('DATABASE_MODULE_OPTIONS')
export const LOGGER_MODULE_OPTIONS = Symbol('LOGGER_MODULE_OPTIONS')

export interface DatabaseModuleOptions {
  url: string
}

export interface RedisModuleOptions {
  url: string
  keyPrefix?: string
}

export interface LoggerModuleOptions {
  pretty?: boolean
}

export interface KitsModuleOptions {
  database?: DatabaseModuleOptions
  redis?: RedisModuleOptions
  logger?: LoggerModuleOptions
}
