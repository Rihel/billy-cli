import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddServiceGrants1795021748273 implements MigrationInterface {
  name = 'AddServiceGrants1795021748273'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_service_grants" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "principal_type" character varying(8) NOT NULL DEFAULT 'admin', "principal_id" character varying(20) NOT NULL, "service" character varying(64) NOT NULL, "granted_by" character varying(20), CONSTRAINT "PK_6a16dfcf984bda4fa0f058cf070" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_service_grant_service" ON "ai_service_grants"  ("service") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_service_grant_principal" ON "ai_service_grants"  ("principal_type", "principal_id") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_service_grant" ON "ai_service_grants"  ("principal_type", "principal_id", "service") `,
    )
    // 存量回填：现有 admin × 存量 manual 服务（code 服务不参与授权）
    await queryRunner.query(`
          INSERT INTO "ai_service_grants" ("id", "principal_type", "principal_id", "service", "granted_by")
          SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 20), 'admin', a."id", s."service", NULL
          FROM "admins" a
          CROSS JOIN "ai_capability_services" s
          WHERE s."snapshot"->>'source' = 'manual' AND a."deleted_at" IS NULL
          ON CONFLICT DO NOTHING
        `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_service_grant"`)
    await queryRunner.query(`DROP INDEX "public"."idx_service_grant_principal"`)
    await queryRunner.query(`DROP INDEX "public"."idx_service_grant_service"`)
    await queryRunner.query(`DROP TABLE "ai_service_grants"`)
  }
}
