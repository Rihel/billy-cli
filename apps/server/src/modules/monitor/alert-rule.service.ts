import { Transactional, type PageQueryResult } from '@repo/kits'
import type {
  CreateAlertRuleDto,
  GetAlertRuleDetailDto,
  PageQueryAlertRuleDto,
  RemoveAlertRuleDto,
  UpdateAlertRuleDto,
} from '@repo/shared'
import { Inject, Injectable } from '@repo/di'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '@repo/kits'
import { AlertRuleRepository } from './alert-rule.repository.js'
import { AlertRuleNameTakenError, AlertRuleNotFoundError } from './errors.js'
import type { AlertRuleEntity } from '../../database/entities/alert-rule-entity.js'

type AlertRuleModel = Omit<AlertRuleEntity, 'deletedAt' | 'generateId'>

@Injectable()
export class AlertRuleService {
  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @Inject(AlertRuleRepository)
    private readonly ruleRepository: AlertRuleRepository,
  ) {}

  @Transactional()
  async create(input: CreateAlertRuleDto): Promise<AlertRuleModel> {
    const existing = await this.ruleRepository.findByName(input.name)
    if (existing) throw new AlertRuleNameTakenError(input.name)
    const rule = await this.ruleRepository.create(input)
    this.logger.log('alertRule.created', { id: rule.id, name: rule.name })
    return rule
  }

  async get(input: GetAlertRuleDetailDto): Promise<AlertRuleModel> {
    const rule = await this.ruleRepository.findById(input.ruleId)
    if (!rule) throw new AlertRuleNotFoundError(input.ruleId)
    return rule
  }

  async page(query: PageQueryAlertRuleDto): Promise<PageQueryResult<AlertRuleModel>> {
    return this.ruleRepository.page(query)
  }

  @Transactional()
  async update(input: UpdateAlertRuleDto): Promise<AlertRuleModel> {
    const { ruleId, ...changes } = input
    if (changes.name) {
      const existing = await this.ruleRepository.findByName(changes.name)
      if (existing && existing.id !== ruleId) {
        throw new AlertRuleNameTakenError(changes.name)
      }
    }
    const rule = await this.ruleRepository.update(ruleId, changes)
    if (!rule) throw new AlertRuleNotFoundError(ruleId)
    this.logger.log('alertRule.updated', { id: ruleId })
    return rule
  }

  @Transactional()
  async remove(input: RemoveAlertRuleDto): Promise<AlertRuleModel> {
    const rule = await this.ruleRepository.remove(input.ruleId)
    if (!rule) throw new AlertRuleNotFoundError(input.ruleId)
    this.logger.log('alertRule.removed', { id: input.ruleId })
    return rule
  }
}
