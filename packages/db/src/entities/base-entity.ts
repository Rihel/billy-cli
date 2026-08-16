import { nanoid } from '@repo/shared'
import {
  BeforeInsert,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm'

export abstract class BaseEntity {
  @PrimaryColumn({ name: 'id', type: 'varchar', length: 20 })
  id!: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamp', precision: 3 })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp', precision: 3 })
  updatedAt!: Date

  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
  })
  deletedAt: Date | null = null

  @BeforeInsert()
  generateId() {
    if (!this.id) this.id = nanoid()
  }
}
