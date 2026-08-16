import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from './base-entity'

@Entity('todos')
@Index('idx_update_at_id', ['updatedAt', 'id'])
export class TodoEntity extends BaseEntity {
  @Column({ name: 'title', type: 'text' })
  title!: string

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null = null

  @Column({ name: 'completed', type: 'boolean', default: false })
  completed = false
}
