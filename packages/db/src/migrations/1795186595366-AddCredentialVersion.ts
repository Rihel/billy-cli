import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCredentialVersion1795186595366 implements MigrationInterface {
  name = 'AddCredentialVersion1795186595366'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "personal_credentials" ADD "version" integer NOT NULL DEFAULT '1'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "personal_credentials" DROP COLUMN "version"`)
  }
}
