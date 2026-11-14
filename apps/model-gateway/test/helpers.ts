import type { GatewayModelEntry } from '@repo/contracts'
import type { GatewayTarget } from '../src/catalog/model.catalog.service.js'

export const entryOf = (overrides: Partial<GatewayModelEntry> = {}): GatewayModelEntry => ({
  id: 'model-1',
  modelRef: 'ollama/qwen3.8:27b',
  modelKey: 'qwen3.8:27b',
  displayName: 'Qwen 3.8 27B',
  providerId: 'provider-1',
  providerName: '本地 Ollama',
  providerSlug: 'ollama',
  providerKind: 'ollama',
  protocol: 'ollama',
  contextWindow: 262144,
  mode: 'chat',
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  ...overrides,
})

export const targetOf = (overrides: Partial<GatewayTarget> = {}): GatewayTarget => ({
  entry: entryOf(),
  apiKey: null,
  baseUrl: 'http://127.0.0.1:11434',
  ...overrides,
})
