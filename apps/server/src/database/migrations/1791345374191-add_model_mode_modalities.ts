import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddModelModeModalities1791345374191 implements MigrationInterface {
  name = 'AddModelModeModalities1791345374191'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_models" ADD "mode" character varying(32) NOT NULL DEFAULT 'chat'`,
    )
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "input_modalities" jsonb`)
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "output_modalities" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "output_modalities"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "input_modalities"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "mode"`)
  }
}
