import { Eta } from 'eta'
import { outdent } from 'outdent'

export const source = outdent({ trimTrailingNewline: false })
const eta = new Eta({ autoEscape: false })

export function render(
  template: string,
  data: Record<string, unknown>,
): string {
  return eta.renderString(template, data)
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
