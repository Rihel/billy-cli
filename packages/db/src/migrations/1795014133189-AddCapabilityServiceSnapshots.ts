import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCapabilityServiceSnapshots1795014133189 implements MigrationInterface {
  name = 'AddCapabilityServiceSnapshots1795014133189'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_capability_services" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "service" character varying(24) NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "PK_a806fc30abce6c4804d8b994d09" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_capability_service" ON "ai_capability_services"  ("service") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_capability_service"`)
    await queryRunner.query(`DROP TABLE "ai_capability_services"`)
  }
}
