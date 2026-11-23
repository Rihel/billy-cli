import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddConversationWorkdir1795449370103 implements MigrationInterface {
  name = 'AddConversationWorkdir1795449370103'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversations" ADD "workdir" character varying(255)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "workdir"`)
  }
}
