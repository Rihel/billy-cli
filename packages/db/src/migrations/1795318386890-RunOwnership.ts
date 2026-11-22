import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunOwnership1795318386890 implements MigrationInterface {
  name = 'AddRunOwnership1795318386890'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "run_ownership" ("run_id" character varying(64) NOT NULL, "owner_id" character varying(128) NOT NULL, "generation" bigint NOT NULL, "lease_expires_at" TIMESTAMP(3), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), CONSTRAINT "PK_2680030755e7470217dee27b0fa" PRIMARY KEY ("run_id"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "run_ownership"`)
  }
}
