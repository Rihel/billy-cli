import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddSkillScopes1795187070810 implements MigrationInterface {
  name = 'AddSkillScopes1795187070810'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_skill_key"`)
    await queryRunner.query(
      `CREATE TABLE "ai_skill_grants" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "skill_key" character varying(64) NOT NULL, "principal_type" character varying(8) NOT NULL, "principal_id" character varying(20) NOT NULL, "granted_by" character varying(20), CONSTRAINT "PK_1a80f5b0391b54bd27532afcdf1" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_skill_grant_principal" ON "ai_skill_grants"  ("principal_type", "principal_id") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_skill_grant" ON "ai_skill_grants"  ("skill_key", "principal_type", "principal_id") WHERE deleted_at IS NULL`,
    )
    await queryRunner.query(
      `ALTER TABLE "ai_skills" ADD "scope" character varying(8) NOT NULL DEFAULT 'platform'`,
    )
    await queryRunner.query(`ALTER TABLE "ai_skills" ADD "owner_type" character varying(8)`)
    await queryRunner.query(`ALTER TABLE "ai_skills" ADD "owner_id" character varying(20)`)
    await queryRunner.query(
      `CREATE INDEX "idx_skill_owner" ON "ai_skills"  ("owner_type", "owner_id") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_skill_personal" ON "ai_skills"  ("owner_type", "owner_id", "skill_key") WHERE "scope" = 'personal' AND "deleted_at" IS NULL`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_skill_platform" ON "ai_skills"  ("skill_key") WHERE "scope" = 'platform' AND "deleted_at" IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_skill_platform"`)
    await queryRunner.query(`DROP INDEX "public"."uk_skill_personal"`)
    await queryRunner.query(`DROP INDEX "public"."idx_skill_owner"`)
    await queryRunner.query(`ALTER TABLE "ai_skills" DROP COLUMN "owner_id"`)
    await queryRunner.query(`ALTER TABLE "ai_skills" DROP COLUMN "owner_type"`)
    await queryRunner.query(`ALTER TABLE "ai_skills" DROP COLUMN "scope"`)
    await queryRunner.query(`DROP INDEX "public"."uk_skill_grant"`)
    await queryRunner.query(`DROP INDEX "public"."idx_skill_grant_principal"`)
    await queryRunner.query(`DROP TABLE "ai_skill_grants"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_skill_key" ON "ai_skills" USING btree ("skill_key") WHERE (deleted_at IS NULL)`,
    )
  }
}
